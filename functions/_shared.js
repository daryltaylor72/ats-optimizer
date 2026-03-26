/**
 * _shared.js — Shared utilities for ATS Optimizer Cloudflare Pages Functions.
 * Underscore prefix prevents this file from being treated as a route by Cloudflare Pages.
 *
 * Exports:
 *  - PLAN_SCANS              : map of plan key → scan count
 *  - PLAN_LABELS             : map of plan key → { name, desc, price }
 *  - generateToken()         : cryptographically secure hex token
 *  - issueToken()            : creates + stores token in KV, returns tokenData
 *  - verifyStripeSignature() : HMAC-SHA256 webhook signature check (Web Crypto API)
 *  - acquireScanMutex()      : distributed KV lock before scan decrement
 *  - releaseScanMutex()      : releases the KV lock after decrement
 */

export const PLAN_SCANS = { single: 1, starter: 5, pro: 9999 };

export const PLAN_LABELS = {
  single:  { name: 'Single Scan',     desc: '1 AI-optimized resume rewrite',      price: '$5'     },
  starter: { name: 'Starter Pack',    desc: '5 AI-optimized resume rewrites',     price: '$19'    },
  pro:     { name: 'Pro — Unlimited', desc: 'Unlimited rewrites for 30 days',     price: '$39/mo' },
};

/** Generates a 48-char hex token using the Web Crypto API. */
export function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Issues a new token for a plan and writes it to KV.
 * Also writes session→token and email→token reverse-lookup keys.
 * Idempotency: caller should check `session:${sessionId}` before calling.
 *
 * @param {KVNamespace} kv
 * @param {string} planKey   - 'single' | 'starter' | 'pro'
 * @param {string} sessionId - Stripe checkout session ID
 * @param {string|null} customerEmail
 * @returns {Object} tokenData
 */
export async function issueToken(kv, planKey, sessionId, customerEmail) {
  const scans     = PLAN_SCANS[planKey] ?? 1;
  const token     = generateToken();
  const ttlDays   = planKey === 'pro' ? 30 : 365;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const ttlSecs   = ttlDays * 24 * 3600;

  const tokenData = {
    token,
    plan:             planKey,
    scans_remaining:  scans,
    created_at:       new Date().toISOString(),
    expires_at:       expiresAt,
    session_id:       sessionId,
    email:            customerEmail || null,
  };

  const writes = [
    kv.put(`token:${token}`,        JSON.stringify(tokenData), { expirationTtl: ttlSecs }),
    kv.put(`session:${sessionId}`,  JSON.stringify(tokenData), { expirationTtl: ttlSecs }),
  ];
  if (customerEmail) {
    writes.push(kv.put(`email:${customerEmail.toLowerCase()}`, token, { expirationTtl: ttlSecs }));
  }
  await Promise.all(writes);

  return tokenData;
}

/**
 * Verifies a Stripe webhook signature using the Web Crypto API (HMAC-SHA256).
 * Stripe signs payloads as: HMAC-SHA256( "<timestamp>.<rawBody>", webhookSecret )
 *
 * @param {string} rawBody         - Raw request body string (before JSON.parse)
 * @param {string} signatureHeader - Value of the `stripe-signature` header
 * @param {string} secret          - STRIPE_WEBHOOK_SECRET
 * @param {number} [toleranceSecs=300] - Max age of the webhook in seconds (replay protection)
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSecs = 300) {
  if (!signatureHeader || !secret) {
    return { ok: false, reason: 'missing_header_or_secret' };
  }

  // Parse "t=<timestamp>,v1=<sig1>,v1=<sig2>,..."
  const parts = Object.fromEntries(
    signatureHeader.split(',').map(part => {
      const idx = part.indexOf('=');
      return [part.slice(0, idx), part.slice(idx + 1)];
    })
  );

  const timestamp = parts['t'];
  // Collect all v1 signatures (Stripe can send multiple during key rotation)
  const v1Sigs = signatureHeader
    .split(',')
    .filter(p => p.startsWith('v1='))
    .map(p => p.slice(3));

  if (!timestamp || v1Sigs.length === 0) {
    return { ok: false, reason: 'malformed_header' };
  }

  // Replay-attack protection: reject events older than toleranceSecs
  const eventAge = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (eventAge > toleranceSecs) {
    return { ok: false, reason: `timestamp_too_old:${eventAge}s` };
  }
  if (eventAge < -toleranceSecs) {
    return { ok: false, reason: `timestamp_in_future:${eventAge}s` };
  }

  // Build the signed payload: "<timestamp>.<rawBody>"
  const signedPayload = `${timestamp}.${rawBody}`;

  // Import the HMAC key
  const enc     = new TextEncoder();
  const keyData = enc.encode(secret);
  const msgData = enc.encode(signedPayload);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );

  const sigBuffer  = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const sigHex     = [...new Uint8Array(sigBuffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison against all provided v1 signatures
  const matched = v1Sigs.some(expected => constantTimeEqual(sigHex, expected));
  return matched
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}

/**
 * Acquires a short-lived distributed mutex on a token's scan count.
 *
 * Problem: KV has no atomic compare-and-swap, so two simultaneous requests can
 * both read scans_remaining > 0, both pass the check, and both decrement —
 * consuming 2 scans for the price of 1.
 *
 * Solution (optimistic mutex):
 *  1. Write a unique mutex ID to `mutex:${token}` with a short TTL.
 *  2. Wait briefly for KV replication to settle.
 *  3. Re-read the key — if it's still our ID, we own the lock.
 *     If it's someone else's ID, we lost the race → return acquired:false → 429.
 *
 * This shrinks the race window from the full AI processing duration (~15s)
 * down to the ~50ms KV settlement window.
 *
 * IMPORTANT: Always pair with releaseScanMutex() in a finally block.
 *
 * @param {KVNamespace} kv
 * @param {string} token
 * @param {number} [ttlSecs=60] - Lock TTL; must exceed max rewrite processing time.
 * @returns {Promise<{acquired: boolean, mutexId: string|null}>}
 */
export async function acquireScanMutex(kv, token, ttlSecs = 60) {
  const mutexKey = `mutex:${token}`;

  // Fast-path: if a mutex already exists, bail immediately
  const existing = await kv.get(mutexKey);
  if (existing) {
    return { acquired: false, mutexId: null };
  }

  // Write our claim
  const mutexId = crypto.randomUUID();
  await kv.put(mutexKey, mutexId, { expirationTtl: ttlSecs });

  // Brief pause: lets any concurrent write that overlapped with ours propagate.
  // KV is strongly consistent per-datacenter for reads-after-writes from the
  // same Worker invocation, but we're racing a *different* invocation.
  await new Promise(r => setTimeout(r, 50));

  // Verify we still hold the lock
  const current = await kv.get(mutexKey);
  if (current !== mutexId) {
    return { acquired: false, mutexId: null };
  }

  return { acquired: true, mutexId };
}

/**
 * Releases the scan mutex for a token.
 * Safe to call even if the mutex has already expired or was never held.
 *
 * @param {KVNamespace} kv
 * @param {string} token
 */
export async function releaseScanMutex(kv, token) {
  try {
    await kv.delete(`mutex:${token}`);
  } catch {
    // Deletion failure is non-fatal — the TTL will clean it up within 60s
  }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true only if both strings are identical in length and content.
 */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
