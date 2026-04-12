/**
 * GET /token-status?token=<hex>
 *
 * Returns live token metadata from KV so the frontend can display
 * accurate scan counts without relying on stale localStorage values.
 *
 * Response shape (200):
 *   { plan, plan_label, scans_remaining, expires_at, created_at, is_unlimited }
 *
 * Errors:
 *   400 – missing or obviously invalid token param
 *   404 – token not found in KV (expired or never issued)
 *   500 – KV not bound
 */
export async function onRequestGet({ env, request }) {
  const kv = env.TOKENS_KV;
  if (!kv) return json({ error: 'KV not configured' }, 500);

  const url   = new URL(request.url);
  const token = (url.searchParams.get('token') || '').trim();

  if (!token || token.length < 10) {
    return json({ error: 'Missing or invalid token parameter' }, 400);
  }

  const raw = await kv.get(`token:${token}`);
  if (!raw) {
    return json({ error: 'Token not found or expired' }, 404);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: 'Corrupt token record' }, 500);
  }

  const PLAN_LABELS = {
    single:  { name: 'Single Scan',     price: '$12'    },
    starter: { name: 'Starter Pack',    price: '$39'    },
    pro:     { name: 'Pro — Unlimited', price: '$49/mo' },
    trial:   { name: 'Trial Access',    price: '$0'     },
  };

  const planMeta    = PLAN_LABELS[data.plan] || { name: data.plan, price: '' };
  const isUnlimited = data.scans_remaining >= 9000;

  return json({
    plan:                   data.plan,
    plan_label:             planMeta.name,
    plan_price:             planMeta.price,
    scans_remaining:        data.scans_remaining,
    is_unlimited:           isUnlimited,
    video_reviews_remaining: data.video_reviews_remaining || 0,
    expires_at:             data.expires_at,
    created_at:             data.created_at,
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',          // always fresh — never cache scan counts
    },
  });
}
