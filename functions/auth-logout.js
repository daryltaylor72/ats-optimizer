import { clearSessionCookie } from './_auth.js';

export async function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
      'Access-Control-Allow-Origin': '*',
    },
  });
}
