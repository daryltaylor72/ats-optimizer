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

  if (hedraResult.status !== 'completed') {
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

  return json({ status: 'complete', videoUrl });
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
