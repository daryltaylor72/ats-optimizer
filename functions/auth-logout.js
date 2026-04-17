import { clearSessionCookie, clearTokenSessionCookie } from './_auth.js';

export async function onRequestPost() {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  headers.append('Set-Cookie', clearSessionCookie());
  headers.append('Set-Cookie', clearTokenSessionCookie());

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers,
  });
}
