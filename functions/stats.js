/**
 * Cloudflare Pages Function — GET /stats
 * Returns public aggregate stats (total scans analyzed).
 * Cached via Cache-Control to avoid hammering KV on every page load.
 */

export async function onRequestGet(context) {
  const { env } = context;
  const kv = env.TOKENS_KV;

  let totalScans = 0;
  if (kv) {
    const raw = await kv.get('stats:total_scans');
    totalScans = parseInt(raw) || 0;
  }

  return new Response(JSON.stringify({ total_scans: totalScans }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
