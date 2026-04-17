import { createTokenSessionCookie, getSessionSecret, redirect } from './_auth.js';
import { generateToken } from './_shared.js';

const DEFAULT_TTL_SECS = 7 * 24 * 60 * 60;

export function getPublicOrigin(env) {
  return env.PUBLIC_APP_ORIGIN || 'https://atscore.ai';
}

export async function createAccessGrant(kv, token, {
  redirectPath = '/tool/',
  ttlSecs = DEFAULT_TTL_SECS,
} = {}) {
  const grant = generateToken();
  const record = {
    token,
    redirect_path: redirectPath,
    created_at: new Date().toISOString(),
  };
  await kv.put(`access-grant:${grant}`, JSON.stringify(record), { expirationTtl: ttlSecs });
  return grant;
}

export function buildAccessGrantUrl(env, grant) {
  return `${getPublicOrigin(env)}/access-link?grant=${encodeURIComponent(grant)}`;
}

export async function consumeAccessGrant(request, env) {
  const kv = env.TOKENS_KV;
  if (!kv) return redirect('/tool/?access=unavailable');

  const url = new URL(request.url);
  const grant = (url.searchParams.get('grant') || '').trim();
  if (!grant) return redirect('/tool/?access=invalid');

  const raw = await kv.get(`access-grant:${grant}`);
  if (!raw) return redirect('/tool/?access=expired');

  await kv.delete(`access-grant:${grant}`);

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return redirect('/tool/?access=invalid');
  }

  const token = record?.token;
  if (!token) return redirect('/tool/?access=invalid');

  const tokenRaw = await kv.get(`token:${token}`);
  if (!tokenRaw) return redirect('/tool/?access=expired');

  let tokenData;
  try {
    tokenData = JSON.parse(tokenRaw);
  } catch {
    return redirect('/tool/?access=invalid');
  }
  if (!tokenData?.expires_at || new Date(tokenData.expires_at) < new Date()) {
    return redirect('/tool/?access=expired');
  }

  const secret = getSessionSecret(env);
  if (!secret) return redirect('/tool/?access=unavailable');

  const cookie = await createTokenSessionCookie(token, secret);
  return redirect(record.redirect_path || '/tool/', { 'Set-Cookie': cookie });
}
