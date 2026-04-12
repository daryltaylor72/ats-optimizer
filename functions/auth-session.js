import { readSession } from './_auth.js';
import { PLAN_LABELS } from './_shared.js';

/**
 * GET /auth-session
 * Returns the signed-in email plus any active token entitlement tied to it.
 */
export async function onRequestGet({ request, env }) {
  const session = await readSession(request, env);
  if (!session?.email) return json({ authenticated: false });

  const kv = env.TOKENS_KV;
  if (!kv) return json({ authenticated: true, email: session.email, has_token: false });

  const tokenRef = await kv.get(`email:${session.email}`);
  if (!tokenRef) {
    return json({
      authenticated: true,
      email: session.email,
      has_token: false,
    });
  }

  const tokenRaw = await kv.get(`token:${tokenRef}`);
  if (!tokenRaw) {
    return json({
      authenticated: true,
      email: session.email,
      has_token: false,
    });
  }

  let tokenData;
  try { tokenData = JSON.parse(tokenRaw); } catch { tokenData = null; }
  if (!tokenData) return json({ authenticated: true, email: session.email, has_token: false });

  const planMeta = PLAN_LABELS[tokenData.plan] || { name: tokenData.plan, price: '' };

  return json({
    authenticated: true,
    email: session.email,
    has_token: true,
    token: tokenRef,
    plan: tokenData.plan,
    plan_label: planMeta.name,
    plan_price: planMeta.price,
    scans_remaining: tokenData.scans_remaining,
    video_reviews_remaining: tokenData.video_reviews_remaining || 0,
    is_unlimited: tokenData.scans_remaining >= 9000,
    expires_at: tokenData.expires_at,
    created_at: tokenData.created_at,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
