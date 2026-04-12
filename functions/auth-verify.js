import { createSessionCookie, getSessionSecret, redirect } from './_auth.js';

/**
 * GET /auth-verify?token=<hex>
 * Verifies a one-time email link, sets the session cookie, and redirects to /tool/.
 */
export async function onRequestGet({ request, env }) {
  const secret = getSessionSecret(env);
  if (!secret) return redirect('/tool/?signin=unavailable');

  const kv = env.TOKENS_KV;
  if (!kv) return redirect('/tool/?signin=unavailable');

  const url = new URL(request.url);
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return redirect('/tool/?signin=invalid');

  const raw = await kv.get(`login:${token}`);
  if (!raw) return redirect('/tool/?signin=expired');

  await kv.delete(`login:${token}`);

  let data;
  try { data = JSON.parse(raw); } catch { return redirect('/tool/?signin=invalid'); }
  if (!data?.email) return redirect('/tool/?signin=invalid');

  const cookie = await createSessionCookie(data.email, secret);
  return redirect('/tool/?signed_in=1', { 'Set-Cookie': cookie });
}
