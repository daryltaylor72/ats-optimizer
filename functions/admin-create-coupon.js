/**
 * Cloudflare Pages Function — POST /admin-create-coupon
 * Creates a new coupon code in KV.
 * Protected by Authorization: Bearer {ADMIN_SECRET}
 * Body: { code: string, uses?: number, expires_days?: number }
 * Returns: { code, uses_remaining, expires_at }
 */

const CORS_ORIGIN = 'https://ats-optimizer.pages.dev';

// Constant-time string comparison to prevent timing attacks on the admin secret
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    // Still compare to avoid length oracle; XOR dummy bytes
    let dummy = 0;
    for (let i = 0; i < b.length; i++) dummy |= (b.charCodeAt(i) ^ b.charCodeAt(i));
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.TOKENS_KV;

  if (!kv) {
    return json({ detail: 'KV store not configured.' }, 500);
  }

  // 1. Check Authorization header
  const authHeader = request.headers.get('Authorization') || '';
  const adminSecret = env.ADMIN_SECRET;

  if (!adminSecret) {
    return json({ detail: 'Admin secret not configured.' }, 500);
  }
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!timingSafeEqual(provided, adminSecret)) {
    return json({ detail: 'Unauthorized.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ detail: 'Invalid JSON body.' }, 400);
  }

  // 2. Normalize code
  const rawCode = body.code;
  if (!rawCode || typeof rawCode !== 'string') {
    return json({ detail: 'Coupon code is required.' }, 400);
  }
  const code = rawCode.trim().toUpperCase();

  // 3. Validate: alphanumeric + hyphens only, 3-30 chars
  if (!/^[A-Z0-9\-]{3,30}$/.test(code)) {
    return json({ detail: 'Coupon code must be 3-30 characters, using only letters, numbers, and hyphens.' }, 400);
  }

  // 4. Check if coupon already exists
  const existing = await kv.get(`coupon:${code}`);
  if (existing) {
    return json({ detail: `Coupon code "${code}" already exists.` }, 409);
  }

  // 5. Build coupon data
  const uses = typeof body.uses === 'number' && body.uses > 0 ? body.uses : 1;
  const now = new Date();

  let expiresAt = null;
  let ttlSecs = null;

  if (body.expires_days && typeof body.expires_days === 'number' && body.expires_days > 0) {
    ttlSecs = Math.floor(body.expires_days) * 24 * 3600;
    expiresAt = new Date(now.getTime() + ttlSecs * 1000).toISOString();
  }

  const couponData = {
    uses_remaining: uses,
    created_at: now.toISOString(),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };

  // 6. Store coupon in KV (with optional TTL)
  const putOptions = ttlSecs ? { expirationTtl: ttlSecs } : {};
  await kv.put(`coupon:${code}`, JSON.stringify(couponData), putOptions);

  // 7. Return coupon data
  return json({
    code,
    uses_remaining: uses,
    expires_at: expiresAt,
  }, 200);
}
