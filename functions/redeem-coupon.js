/**
 * Cloudflare Pages Function — POST /redeem-coupon
 * Redeems a coupon code and issues a 1-scan trial token.
 * Body: { code: string, email?: string }
 * Returns: { token, scans_remaining, expires_at, message }
 */

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

  // 1. Normalize: trim + uppercase
  const code = rawCode.trim().toUpperCase();

  // 2. Look up coupon in KV
  const couponRaw = await kv.get(`coupon:${code}`);
  if (!couponRaw) {
    return json({ detail: 'Invalid or expired coupon code.' }, 404);
  }

  let coupon;
  try {
    coupon = JSON.parse(couponRaw);
  } catch {
    return json({ detail: 'Coupon data is corrupted. Please contact support.' }, 500);
  }

  // 3. Check uses_remaining
  if (coupon.uses_remaining <= 0) {
    return json({ detail: 'This coupon code has already been used.' }, 410);
  }

  // 4. Check expiry (if set)
  if (coupon.expires_at) {
    const expiry = new Date(coupon.expires_at);
    if (expiry < new Date()) {
      return json({ detail: 'This coupon code has expired.' }, 410);
    }
  }

  // 5. Decrement uses_remaining (acceptable race condition for promo codes)
  const updatedCoupon = {
    ...coupon,
    uses_remaining: coupon.uses_remaining - 1,
  };
  await kv.put(`coupon:${code}`, JSON.stringify(updatedCoupon));

  // 6. Generate new token UUID
  const tokenId = crypto.randomUUID();

  // 7. Calculate expiry: 30 days from now
  const ttlDays = 30;
  const ttlSecs = ttlDays * 24 * 3600;
  const expiresAt = new Date(Date.now() + ttlSecs * 1000).toISOString();

  const email = (body.email || '').trim();

  const tokenData = {
    scans_remaining: 1,
    expires_at: expiresAt,
    plan: 'trial',
    email: email,
    created_at: new Date().toISOString(),
    source: `coupon:${code}`,
  };

  // 8. Store token in KV
  await kv.put(`token:${tokenId}`, JSON.stringify(tokenData), { expirationTtl: ttlSecs });

  // 9. Return success
  return json({
    token: tokenId,
    scans_remaining: 1,
    expires_at: expiresAt,
    message: 'Your free trial is ready!',
  }, 200);
}
