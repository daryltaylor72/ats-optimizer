/**
 * Cloudflare Pages Function — POST /redeem-coupon
 * Redeems a coupon code and issues a 1-scan trial token.
 * Body: { code: string, email?: string }
 * Returns: { token, scans_remaining, expires_at, message }
 */

import { acquireScanMutex, releaseScanMutex } from './_shared.js';

const CORS_ORIGIN = 'https://ats-optimizer.pages.dev';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.TOKENS_KV;

  if (!kv) {
    return json({ detail: 'KV store not configured.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ detail: 'Invalid JSON body.' }, 400);
  }

  const rawCode = body.code;
  if (!rawCode || typeof rawCode !== 'string') {
    return json({ detail: 'Coupon code is required.' }, 400);
  }

  const code = rawCode.trim().toUpperCase();

  // Fast pre-check before acquiring mutex — avoids lock delay for clearly invalid codes
  const preCouponRaw = await kv.get(`coupon:${code}`);
  if (!preCouponRaw) {
    return json({ detail: 'Invalid or expired coupon code.' }, 404);
  }

  let preCheck;
  try { preCheck = JSON.parse(preCouponRaw); }
  catch { return json({ detail: 'Coupon data is corrupted. Please contact support.' }, 500); }

  if (preCheck.uses_remaining <= 0) {
    return json({ detail: 'This coupon code has already been used.' }, 410);
  }
  if (preCheck.expires_at && new Date(preCheck.expires_at) < new Date()) {
    return json({ detail: 'This coupon code has expired.' }, 410);
  }

  // Acquire mutex using the coupon code as the lock key to prevent double-redemption
  const mutexKey = `coupon:${code}`;
  const { acquired } = await acquireScanMutex(kv, mutexKey);
  if (!acquired) {
    return json({ detail: 'Another request is processing this code. Please try again in a moment.' }, 429);
  }

  let tokenId, expiresAt;
  try {
    // Re-read under lock — state may have changed
    const lockedRaw = await kv.get(`coupon:${code}`);
    if (!lockedRaw) return json({ detail: 'Invalid or expired coupon code.' }, 404);

    let coupon;
    try { coupon = JSON.parse(lockedRaw); }
    catch { return json({ detail: 'Coupon data is corrupted.' }, 500); }

    if (coupon.uses_remaining <= 0) {
      return json({ detail: 'This coupon code has already been used.' }, 410);
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return json({ detail: 'This coupon code has expired.' }, 410);
    }

    // Decrement under lock
    const updated = { ...coupon, uses_remaining: coupon.uses_remaining - 1 };
    await kv.put(`coupon:${code}`, JSON.stringify(updated));

    // Generate and store token
    tokenId = crypto.randomUUID();
    const ttlSecs = 30 * 24 * 3600;
    expiresAt = new Date(Date.now() + ttlSecs * 1000).toISOString();
    const email = (body.email || '').trim();

    const tokenData = {
      scans_remaining: 1,
      expires_at: expiresAt,
      plan: 'trial',
      email,
      created_at: new Date().toISOString(),
      source: `coupon:${code}`,
    };
    await kv.put(`token:${tokenId}`, JSON.stringify(tokenData), { expirationTtl: ttlSecs });
  } finally {
    await releaseScanMutex(kv, mutexKey);
  }

  return json({
    token: tokenId,
    scans_remaining: 1,
    expires_at: expiresAt,
    message: 'Your free trial is ready!',
  });
}
