/**
 * GET /video-status?jobId={jobId}&token={token}
 *
 * Polls the status of a Hedra video generation job.
 * When Hedra reports 'completed', downloads the video and uploads it to R2.
 *
 * Returns:
 *   { status: 'processing' }
 *   { status: 'complete', videoUrl: 'https://...' }
 *   { status: 'failed' }
 */

import { hedraGetStatus } from './_video-helpers.js';

const TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes — mark as failed if exceeded

export async function onRequestGet(context) {
  const { request, env } = context;
  const url    = new URL(request.url);
  const jobId  = url.searchParams.get('jobId')  || '';
  const token  = url.searchParams.get('token')  || '';

  if (!jobId || !token) return json({ detail: 'Missing jobId or token' }, 400);

  const kv           = env.TOKENS_KV;
  const hedraKey     = env.HEDRA_API_KEY;
  const bucket       = env.VIDEO_BUCKET;
  const r2PublicUrl  = env.R2_VIDEOS_PUBLIC_URL;

  if (!kv || !hedraKey || !bucket || !r2PublicUrl) {
    return json({ detail: 'Service not configured' }, 500);
  }

  // Read job record
  const raw = await kv.get(`video:${jobId}`);
  if (!raw) return json({ detail: 'Job not found' }, 404);

  let record;
  try {
    record = JSON.parse(raw);
  } catch (_e) {
    return json({ detail: 'Invalid job record' }, 500);
  }

  // Ownership check — prevents job ID enumeration
  if (record.token !== token) return json({ detail: 'Forbidden' }, 403);

  // Already resolved
  if (record.status === 'complete') return json({ status: 'complete', videoUrl: record.videoUrl });
  if (record.status === 'failed')   return json({ status: 'failed' });

  // Timeout check
  const ageMs = record.createdAt
    ? Date.now() - new Date(record.createdAt).getTime()
    : Infinity;
  if (ageMs > TIMEOUT_MS) {
    await kv.put(`video:${jobId}`, JSON.stringify({ ...record, status: 'failed' }), { expirationTtl: 86400 });
    return json({ status: 'failed' });
  }

  // Poll Hedra
  let hedraResult;
  try {
    hedraResult = await hedraGetStatus(record.hedraJobId, hedraKey);
  } catch (_e) {
    // Transient Hedra error — don't fail the job, let client retry
    return json({ status: 'processing' });
  }

  if (hedraResult.status !== 'complete') {
    return json({ status: 'processing' });
  }

  // Hedra completed — download video, upload to R2
  let videoUrl = hedraResult.videoUrl; // fallback: Hedra CDN URL (~24h expiry)
  try {
    const videoResp = await fetch(hedraResult.videoUrl);
    if (videoResp.ok) {
      const videoBuffer = await videoResp.arrayBuffer();
      const r2Key = `${jobId}.mp4`;
      await bucket.put(r2Key, videoBuffer, {
        httpMetadata: { contentType: 'video/mp4' },
      });
      videoUrl = `${r2PublicUrl}/${r2Key}`;
    }
  } catch (_e) {
    // R2 upload failed — videoUrl stays as Hedra CDN URL
  }

  // Persist completed state
  await kv.put(
    `video:${jobId}`,
    JSON.stringify({ ...record, status: 'complete', videoUrl }),
    { expirationTtl: 86400 }
  );

  // Send email notification (fire-and-forget — don't block the response)
  if (record.email && env.RESEND_API_KEY) {
    sendVideoEmail(record.email, record.name, videoUrl, env.RESEND_API_KEY).catch(() => {});
  }

  return json({ status: 'complete', videoUrl });
}

async function sendVideoEmail(to, name, videoUrl, apiKey) {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:40px auto;padding:32px;background:#111318;border-radius:16px;border:1px solid rgba(255,255,255,0.08);">
    <h1 style="color:#e8eaf0;font-size:22px;margin:0 0 12px;">Your AI Video Review is Ready</h1>
    <p style="color:#9299b0;font-size:14px;line-height:1.6;margin:0 0 24px;">${greeting} Your personalized career coaching video has finished generating.</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${videoUrl}" target="_blank" style="display:inline-block;background:#6c63ff;color:#fff;font-size:15px;font-weight:600;padding:14px 32px;border-radius:10px;text-decoration:none;">▶ Watch Your Coaching Video</a>
    </div>
    <p style="color:#5a6080;font-size:12px;line-height:1.5;margin:24px 0 0;">The video link is valid for 24 hours. If you need to access it again, generate a new video review from the tool.</p>
    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;margin-top:24px;text-align:center;">
      <p style="color:#5a6080;font-size:12px;margin:0;">ATScore · <a href="https://atscore.ai" style="color:#6c63ff;text-decoration:none;">atscore.ai</a></p>
    </div>
  </div>
</body>
</html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'ATScore <results@atscore.ai>',
      reply_to: ['support@atscore.ai'],
      to: [to],
      subject: '▶ Your AI Career Coaching Video is Ready',
      html,
    }),
  });
  if (!r.ok) throw new Error(await r.text());
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': 'https://ats-optimizer.pages.dev',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://ats-optimizer.pages.dev',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
