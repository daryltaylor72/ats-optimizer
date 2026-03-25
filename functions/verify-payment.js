/**
 * GET /verify-payment?session_id=cs_xxx&plan=starter
 * Verifies Stripe payment, issues a token stored in KV.
 * Returns: { token, plan, scans_remaining }
 */

function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

const PLAN_SCANS = { single: 1, starter: 5, pro: 9999 };

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  const planKey   = url.searchParams.get('plan');

  if (!sessionId || !planKey) return json({ error: 'Missing params' }, 400);

  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);

  // Verify the session with Stripe
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` },
  });
  const session = await res.json();

  if (!res.ok || session.payment_status !== 'paid') {
    // Subscriptions use 'no_payment_required' before first invoice — check status
    const isSubscriptionActive =
      session.mode === 'subscription' && session.status === 'complete';
    if (!isSubscriptionActive) {
      return json({ error: 'Payment not confirmed' }, 402);
    }
  }

  // Check if we already issued a token for this session (prevent double-issue)
  const kv = env.TOKENS_KV;
  if (kv) {
    const existing = await kv.get(`session:${sessionId}`);
    if (existing) {
      const token = JSON.parse(existing);
      return json({ token: token.token, plan: token.plan, scans_remaining: token.scans_remaining });
    }
  }

  const scans = PLAN_SCANS[planKey] || 1;
  const token = generateToken();
  const expiresAt = planKey === 'pro'
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()  // 30 days
    : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); // 1 year

  const tokenData = {
    token,
    plan: planKey,
    scans_remaining: scans,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    session_id: sessionId,
  };

  // Store token in KV (primary key) and session→token mapping
  if (kv) {
    const ttlSeconds = planKey === 'pro' ? 30 * 24 * 3600 : 365 * 24 * 3600;
    await Promise.all([
      kv.put(`token:${token}`, JSON.stringify(tokenData), { expirationTtl: ttlSeconds }),
      kv.put(`session:${sessionId}`, JSON.stringify(tokenData), { expirationTtl: ttlSeconds }),
    ]);
  }

  return json({ token, plan: planKey, scans_remaining: scans });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
