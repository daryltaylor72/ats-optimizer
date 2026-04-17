/**
 * Lightweight email-link auth helpers for ATScore.
 * Prefer AUTH_SESSION_SECRET when configured, but fall back to an existing
 * server secret so the feature can run without a separate migration step.
 */

const SESSION_COOKIE = 'ats_session';
const TOKEN_COOKIE = 'ats_token_session';
const SESSION_TTL_SECS = 30 * 24 * 60 * 60;

export function getSessionSecret(env) {
  return env.AUTH_SESSION_SECRET || env.STRIPE_WEBHOOK_SECRET || env.RESEND_API_KEY || null;
}

export function parseCookies(request) {
  const raw = request.headers.get('cookie') || '';
  const out = {};
  for (const part of raw.split(/;\s*/)) {
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    out[key] = value;
  }
  return out;
}

export async function createSessionCookie(email, secret, ttlSecs = SESSION_TTL_SECS) {
  const payload = {
    email: email.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + ttlSecs,
  };
  const encoded = base64urlEncode(JSON.stringify(payload));
  const sig = await sign(encoded, secret);
  return serializeSessionCookie(`${encoded}.${sig}`, ttlSecs);
}

export async function readSession(request, env) {
  const secret = getSessionSecret(env);
  if (!secret) return null;

  const cookies = parseCookies(request);
  const raw = cookies[SESSION_COOKIE];
  if (!raw || !raw.includes('.')) return null;

  const [encoded, sig] = raw.split('.');
  const expected = await sign(encoded, secret);
  if (!constantTimeEqual(sig, expected)) return null;

  try {
    const payload = JSON.parse(base64urlDecode(encoded));
    if (!payload?.email || !payload?.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createTokenSessionCookie(token, secret, ttlSecs = SESSION_TTL_SECS) {
  const payload = {
    token,
    exp: Math.floor(Date.now() / 1000) + ttlSecs,
  };
  const encoded = base64urlEncode(JSON.stringify(payload));
  const sig = await sign(encoded, secret);
  return serializeCookie(TOKEN_COOKIE, `${encoded}.${sig}`, ttlSecs);
}

export async function readTokenSession(request, env) {
  const secret = getSessionSecret(env);
  if (!secret) return null;

  const cookies = parseCookies(request);
  const raw = cookies[TOKEN_COOKIE];
  if (!raw || !raw.includes('.')) return null;

  const [encoded, sig] = raw.split('.');
  const expected = await sign(encoded, secret);
  if (!constantTimeEqual(sig, expected)) return null;

  try {
    const payload = JSON.parse(base64urlDecode(encoded));
    if (!payload?.token || !payload?.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', 0);
}

export function clearTokenSessionCookie() {
  return serializeCookie(TOKEN_COOKIE, '', 0);
}

export function redirect(url, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      ...headers,
    },
  });
}

function serializeSessionCookie(value, maxAge) {
  return serializeCookie(SESSION_COOKIE, value, maxAge);
}

function serializeCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function sign(input, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(input));
  return base64urlFromBytes(new Uint8Array(sig));
}

function base64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  return atob(padded);
}

function base64urlFromBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
