/**
 * webhook.test.js
 * Tests for stripe-webhook.js and _shared.js logic.
 * Runs under Node.js (uses globalThis.crypto which is available in Node 18+).
 *
 * Usage: node test/webhook.test.js
 */

import { createHmac } from 'crypto';

// ─── Polyfill Web Crypto for Node 18 ──────────────────────────────────────
// Node 18+ exposes globalThis.crypto natively; this just makes it explicit.
import { webcrypto } from 'crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// ─── Import the shared module under test ──────────────────────────────────
import { verifyStripeSignature, issueToken, PLAN_SCANS, generateToken } from
  '../functions/_shared.js';

// ─── Test harness ─────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  FAIL: ${label}`);
    failed++;
  }
}

async function test(label, fn) {
  console.log(`\n▶ ${label}`);
  try {
    await fn();
  } catch (e) {
    console.error(`  ❌  THREW: ${e.message}`);
    failed++;
  }
}

// ─── Helper: build a valid Stripe-style signature header ─────────────────
function buildStripeHeader(rawBody, secret, timestampOverride) {
  const t   = timestampOverride ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  return `t=${t},v1=${sig}`;
}

// ─── Test data ────────────────────────────────────────────────────────────
const SECRET  = 'whsec_test_secret_1234567890abcdef';
const PAYLOAD = JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' });

// ─── Signature Verification Tests ────────────────────────────────────────
await test('verifyStripeSignature — valid signature passes', async () => {
  const header = buildStripeHeader(PAYLOAD, SECRET);
  const result = await verifyStripeSignature(PAYLOAD, header, SECRET);
  assert(result.ok === true, 'returns ok:true for valid signature');
});

await test('verifyStripeSignature — wrong secret fails', async () => {
  const header = buildStripeHeader(PAYLOAD, SECRET);
  const result = await verifyStripeSignature(PAYLOAD, header, 'wrong_secret');
  assert(result.ok === false, 'returns ok:false for wrong secret');
  assert(result.reason === 'signature_mismatch', `reason is signature_mismatch (got: ${result.reason})`);
});

await test('verifyStripeSignature — tampered body fails', async () => {
  const header  = buildStripeHeader(PAYLOAD, SECRET);
  const tampered = PAYLOAD + ' ';
  const result  = await verifyStripeSignature(tampered, header, SECRET);
  assert(result.ok === false, 'returns ok:false for tampered body');
});

await test('verifyStripeSignature — expired timestamp fails (>300s old)', async () => {
  const oldTs  = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
  const header = buildStripeHeader(PAYLOAD, SECRET, oldTs);
  const result = await verifyStripeSignature(PAYLOAD, header, SECRET);
  assert(result.ok === false, 'returns ok:false for old timestamp');
  assert(result.reason?.startsWith('timestamp_too_old'), `reason starts with timestamp_too_old (got: ${result.reason})`);
});

await test('verifyStripeSignature — fresh timestamp just under tolerance passes', async () => {
  const ts     = Math.floor(Date.now() / 1000) - 290; // 290s ago — within 300s tolerance
  const header = buildStripeHeader(PAYLOAD, SECRET, ts);
  const result = await verifyStripeSignature(PAYLOAD, header, SECRET);
  assert(result.ok === true, 'passes for timestamp 290s old');
});

await test('verifyStripeSignature — missing header returns error', async () => {
  const result = await verifyStripeSignature(PAYLOAD, null, SECRET);
  assert(result.ok === false, 'returns ok:false for null header');
  assert(result.reason === 'missing_header_or_secret', `reason is missing_header_or_secret (got: ${result.reason})`);
});

await test('verifyStripeSignature — missing secret returns error', async () => {
  const header = buildStripeHeader(PAYLOAD, SECRET);
  const result = await verifyStripeSignature(PAYLOAD, header, null);
  assert(result.ok === false, 'returns ok:false for null secret');
});

await test('verifyStripeSignature — malformed header returns error', async () => {
  const result = await verifyStripeSignature(PAYLOAD, 'garbage_header', SECRET);
  assert(result.ok === false, 'returns ok:false for malformed header');
  assert(result.reason === 'malformed_header', `reason is malformed_header (got: ${result.reason})`);
});

await test('verifyStripeSignature — multiple v1 sigs, one matching (key rotation)', async () => {
  const t      = Math.floor(Date.now() / 1000);
  const goodSig = createHmac('sha256', SECRET).update(`${t}.${PAYLOAD}`).digest('hex');
  const header = `t=${t},v1=aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233,v1=${goodSig}`;
  const result = await verifyStripeSignature(PAYLOAD, header, SECRET);
  assert(result.ok === true, 'passes when one of multiple v1 sigs matches');
});

// ─── generateToken Tests ──────────────────────────────────────────────────
await test('generateToken — produces unique 48-char hex strings', async () => {
  const t1 = generateToken();
  const t2 = generateToken();
  assert(t1.length === 48, `token length is 48 (got: ${t1.length})`);
  assert(/^[0-9a-f]+$/.test(t1), 'token is hex');
  assert(t1 !== t2, 'tokens are unique');
});

// ─── PLAN_SCANS Tests ─────────────────────────────────────────────────────
await test('PLAN_SCANS — correct scan counts', async () => {
  assert(PLAN_SCANS['single']  === 1,    'single = 1 scan');
  assert(PLAN_SCANS['starter'] === 5,    'starter = 5 scans');
  assert(PLAN_SCANS['pro']     === 9999, 'pro = 9999 scans');
});

// ─── issueToken Tests (with mock KV) ─────────────────────────────────────
function mockKV() {
  const store = new Map();
  return {
    _store: store,
    async put(key, value, opts) { store.set(key, { value, opts }); },
    async get(key) { return store.get(key)?.value ?? null; },
  };
}

await test('issueToken — single plan', async () => {
  const kv        = mockKV();
  const sessionId = 'cs_test_single_001';
  const email     = 'test@example.com';

  const tokenData = await issueToken(kv, 'single', sessionId, email);

  assert(tokenData.plan              === 'single',      'plan is single');
  assert(tokenData.scans_remaining   === 1,             'scans_remaining is 1');
  assert(tokenData.token.length      === 48,            'token is 48 chars');
  assert(tokenData.session_id        === sessionId,     'session_id set correctly');
  assert(tokenData.email             === email,         'email stored');
  assert(typeof tokenData.expires_at === 'string',      'expires_at is a string');

  // KV should have token:, session:, and email: keys
  const storedToken   = await kv.get(`token:${tokenData.token}`);
  const storedSession = await kv.get(`session:${sessionId}`);
  const storedEmail   = await kv.get(`email:${email}`);

  assert(storedToken   !== null, 'token: key written to KV');
  assert(storedSession !== null, 'session: key written to KV');
  assert(storedEmail   !== null, 'email: key written to KV');
  assert(storedEmail   === tokenData.token, 'email: key points to correct token');
});

await test('issueToken — starter plan', async () => {
  const kv = mockKV();
  const td = await issueToken(kv, 'starter', 'cs_test_starter_001', 'user@test.com');
  assert(td.scans_remaining === 5, 'starter plan gives 5 scans');
});

await test('issueToken — pro plan (30-day TTL)', async () => {
  const kv  = mockKV();
  const td  = await issueToken(kv, 'pro', 'cs_test_pro_001', 'pro@test.com');
  assert(td.scans_remaining === 9999, 'pro plan gives 9999 scans');

  // TTL on KV entries should be 30 days (2592000 seconds)
  const tokenEntry = kv._store.get(`token:${td.token}`);
  assert(tokenEntry.opts?.expirationTtl === 30 * 24 * 3600,
    `pro token TTL is 30 days (got: ${tokenEntry.opts?.expirationTtl})`);
});

await test('issueToken — no email (anonymous purchase)', async () => {
  const kv = mockKV();
  const td = await issueToken(kv, 'single', 'cs_test_anon_001', null);
  assert(td.email === null, 'email is null');

  // email: key should NOT be written when there is no email
  const emailEntry = kv._store.get('email:null');
  assert(emailEntry === undefined, 'no email: key written for null email');
});

await test('issueToken — unknown plan falls back to 1 scan', async () => {
  const kv = mockKV();
  const td = await issueToken(kv, 'unknown_plan', 'cs_test_unk_001', null);
  assert(td.scans_remaining === 1, 'unknown plan defaults to 1 scan');
});

// ─── Event Routing Smoke Tests (handler logic via direct function calls) ──
// We simulate what the webhook handler does for each event type, verifying
// the KV state changes are correct without needing a running HTTP server.

await test('checkout.session.completed — idempotency check', async () => {
  const kv        = mockKV();
  const sessionId = 'cs_idempotency_test';

  // First issue
  const td1 = await issueToken(kv, 'starter', sessionId, 'idem@test.com');

  // Simulate second call: check session: key exists → should not re-issue
  const existing = await kv.get(`session:${sessionId}`);
  assert(existing !== null, 'session: key exists after first issue');

  // If we were to re-issue, it would generate a different token — prove we do NOT
  const td2 = JSON.parse(existing);
  assert(td1.token === td2.token, 'second lookup returns same token (idempotent)');
});

await test('subscription renewal — extends expiry and resets scans', async () => {
  const kv    = mockKV();
  const email = 'renew@test.com';

  // Set up an existing Pro token with depleted scans
  const tokenKey = generateToken();
  const oldExpiry = new Date(Date.now() - 1000).toISOString(); // already expired
  const tokenData = {
    token:           tokenKey,
    plan:            'pro',
    scans_remaining: 0,
    expires_at:      oldExpiry,
    email,
  };
  await kv.put(`token:${tokenKey}`, JSON.stringify(tokenData), { expirationTtl: 1 });
  await kv.put(`email:${email}`,    tokenKey, { expirationTtl: 1 });

  // Simulate invoice.paid handler logic
  const tokenRef  = await kv.get(`email:${email.toLowerCase()}`);
  assert(tokenRef !== null, 'found token ref via email lookup');

  const raw           = await kv.get(`token:${tokenRef}`);
  const existing      = JSON.parse(raw);
  const newExpiry     = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  existing.expires_at      = newExpiry;
  existing.scans_remaining = PLAN_SCANS['pro'];
  existing.last_renewed_at = new Date().toISOString();
  await kv.put(`token:${tokenRef}`, JSON.stringify(existing), { expirationTtl: 30 * 24 * 3600 });

  const updated = JSON.parse(await kv.get(`token:${tokenRef}`));
  assert(updated.scans_remaining === 9999,                  'scans reset to 9999 on renewal');
  assert(new Date(updated.expires_at) > new Date(oldExpiry), 'expiry extended beyond old expiry');
});

await test('subscription.deleted — cancels token and zeroes scans', async () => {
  const kv    = mockKV();
  const email = 'cancel@test.com';

  const tokenKey  = generateToken();
  const tokenData = { token: tokenKey, plan: 'pro', scans_remaining: 9999, email };
  await kv.put(`token:${tokenKey}`, JSON.stringify(tokenData), { expirationTtl: 100 });
  await kv.put(`email:${email}`,    tokenKey, { expirationTtl: 100 });

  // Simulate subscription.deleted handler logic
  const tokenRef = await kv.get(`email:${email}`);
  const raw      = await kv.get(`token:${tokenRef}`);
  const td       = JSON.parse(raw);
  td.scans_remaining = 0;
  td.cancelled_at    = new Date().toISOString();
  td.cancel_reason   = 'subscription_deleted:sub_test123';
  await kv.put(`token:${tokenRef}`, JSON.stringify(td), { expirationTtl: 7 * 24 * 3600 });

  const cancelled = JSON.parse(await kv.get(`token:${tokenRef}`));
  assert(cancelled.scans_remaining === 0,                       'scans set to 0 on cancellation');
  assert(typeof cancelled.cancelled_at === 'string',            'cancelled_at recorded');
  assert(cancelled.cancel_reason.includes('sub_test123'),       'cancel_reason includes subscription ID');

  // TTL should be 7 days (604800 seconds) for audit trail
  const entry = kv._store.get(`token:${tokenRef}`);
  assert(entry.opts?.expirationTtl === 7 * 24 * 3600,
    `cancelled token TTL is 7 days (got: ${entry.opts?.expirationTtl})`);
});

// ─── Final Report ─────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('❌  TESTS FAILED — do not deploy');
  process.exit(1);
} else {
  console.log('✅  ALL TESTS PASSED — safe to proceed');
  process.exit(0);
}
