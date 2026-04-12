export async function onRequestPost(context) {
  const { request } = context;

  let payload = null;
  try {
    payload = await request.json();
  } catch {
    try {
      payload = await request.text();
    } catch {
      payload = null;
    }
  }

  const report = normalizeReportPayload(payload);
  console.warn('[csp-report]', JSON.stringify({
    document_uri: report.document_uri,
    violated_directive: report.violated_directive,
    effective_directive: report.effective_directive,
    blocked_uri: report.blocked_uri,
    source_file: report.source_file,
    disposition: report.disposition,
  }));

  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function normalizeReportPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  if (payload['csp-report'] && typeof payload['csp-report'] === 'object') {
    return payload['csp-report'];
  }
  if (payload.body && typeof payload.body === 'object') {
    return payload.body;
  }
  return payload;
}
