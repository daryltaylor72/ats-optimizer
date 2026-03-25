/**
 * POST /test-token — TEST ONLY, REMOVE BEFORE PRODUCTION
 * Creates a token directly in KV for automated scan-limit testing.
 * Protected by a test secret so it cannot be abused on the live site.
 * Body: { plan: 'single'|'starter'|'pro', test_secret: string }
 */

const PLAN_SCANS = { single: 1, starter: 5, pro: 9999 };
const TEST_SECRET = 'ats-test-2026-daryl';

function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (body.test_secret !== TEST_SECRET) return json({ error: 'Forbidden' }, 403);

  const kv = env.TOKENS_KV;
  if (!kv) return json({ error: 'KV not configured' }, 500);

  const planKey = body.plan;
  const scans = PLAN_SCANS[planKey];
  if (scans === undefined) return json({ error: 'Invalid plan' }, 400);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const tokenData = {
    token, plan: planKey, scans_remaining: scans,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    session_id: `test-${Date.now()}`,
  };

  await kv.put(`token:${token}`, JSON.stringify(tokenData), { expirationTtl: 365 * 24 * 3600 });

  return json({ token, plan: planKey, scans_remaining: scans });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
