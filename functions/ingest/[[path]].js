// PostHog reverse proxy — routes /ingest/* through atscore.ai
// so ad blockers don't block analytics requests to us.i.posthog.com.

const POSTHOG_HOST = "https://us.i.posthog.com";

export async function onRequest(context) {
  const { request, params } = context;
  const pathname = params.path ? params.path.join("/") : "";
  const url = new URL(request.url);

  const target = new URL(`/${pathname}${url.search}`, POSTHOG_HOST);

  const headers = new Headers(request.headers);
  headers.set("Host", new URL(POSTHOG_HOST).hostname);
  // Remove Cloudflare-specific headers that PostHog doesn't need
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");

  const response = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  });

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}
