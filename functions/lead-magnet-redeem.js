import { createTokenSessionCookie, getSessionSecret } from './_auth.js';
import { acquireScanMutex, grantToken, releaseScanMutex } from './_shared.js';

export async function onRequestPost({ request, env }) {
  const kv = env.TOKENS_KV;
  if (!kv) return json({ ok: false, detail: 'KV store not configured.' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, detail: 'Invalid JSON body.' }, 400); }

  const rawCode = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!rawCode) return json({ ok: false, detail: 'Unlock code is required.' }, 400);

  const emailRef = await kv.get(`leadmagnet:code:${rawCode}`);
  if (!emailRef) return json({ ok: false, detail: 'Invalid or expired unlock code.' }, 404);

  const claimKey = `leadmagnet:claim:${emailRef}`;
  const mutexKey = `leadmagnet:${rawCode}`;
  const { acquired } = await acquireScanMutex(kv, mutexKey);
  if (!acquired) {
    return json({ ok: false, detail: 'Another request is processing this code. Please try again.' }, 429);
  }

  try {
    const rawClaim = await kv.get(claimKey);
    if (!rawClaim) return json({ ok: false, detail: 'Invalid or expired unlock code.' }, 404);

    let claim;
    try { claim = JSON.parse(rawClaim); }
    catch { return json({ ok: false, detail: 'Unlock record is corrupted.' }, 500); }

    if (claim.status === 'redeemed') {
      return json({ ok: false, detail: 'This unlock code has already been used.' }, 410);
    }
    if (claim.expires_at && new Date(claim.expires_at) < new Date()) {
      return json({ ok: false, detail: 'This unlock code has expired.' }, 410);
    }

    claim.status = 'redeemed';
    claim.redeemed_at = new Date().toISOString();

    const tokenData = await grantToken(kv, {
      planKey: 'trial',
      scans: 1,
      videoReviews: 0,
      ttlDays: 30,
      customerEmail: claim.email,
      source: `leadmagnet:${rawCode}`,
    });

    const ttl = Math.max(60, Math.ceil((Date.parse(claim.expires_at || claim.redeemed_at) - Date.now()) / 1000) || 60);
    await kv.put(claimKey, JSON.stringify(claim), { expirationTtl: ttl });

    return json({
      ok: true,
      scans_remaining: tokenData.scans_remaining,
      video_reviews_remaining: tokenData.video_reviews_remaining || 0,
      expires_at: tokenData.expires_at,
      message: 'Your premium report is unlocked.',
    }, 200, await sessionHeaders(env, tokenData.token));
  } finally {
    await releaseScanMutex(kv, mutexKey);
  }
}

async function sessionHeaders(env, token) {
  const secret = getSessionSecret(env);
  if (!secret || !token) return {};
  return {
    'Set-Cookie': await createTokenSessionCookie(token, secret),
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
