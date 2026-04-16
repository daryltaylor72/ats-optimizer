/**
 * POST /video-review — Token-gated AI career coaching script generator
 * Form fields: resume (file), job_description (text, optional), token (string)
 * Returns: { script, name_extracted, duration_estimate_seconds, key_strengths, improvements, next_step, scans_remaining }
 */

import mammoth from 'mammoth';
import { heygenStartJob } from './_video-helpers.js';
import { acquireScanMutex, releaseScanMutex } from './_shared.js';
import {
  applyRateLimit,
  sanitizeVideoReviewResult,
  validateMultipartSize,
  validateResumeUpload,
} from './_upload-security.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const sizeGuard = validateMultipartSize(request);
  if (sizeGuard) {
    return sizeGuard;
  }

  const rateLimitResponse = await applyRateLimit(
    env.TOKENS_KV,
    request,
    'video-review',
    10,
    3600,
    'Too many video review requests. Please try again in an hour.'
  );
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  let formData;
  try { formData = await request.formData(); }
  catch { return json({ detail: 'Invalid form data' }, 400); }

  const token       = formData.get('token') || '';
  const resumeFile  = formData.get('resume');
  const jobDesc     = formData.get('job_description') || '';

  // Validate token
  const kv = env.TOKENS_KV;
  if (!kv) return json({ detail: 'Token system not configured', code: 'no_kv' }, 500);

  // Fast pre-check before acquiring mutex
  const preCheckRaw = await kv.get(`token:${token}`);
  if (!preCheckRaw) return json({ detail: 'Invalid or expired token.', code: 'invalid_token' }, 401);
  const preCheck = JSON.parse(preCheckRaw);
  if (new Date(preCheck.expires_at) < new Date()) {
    return json({ detail: 'Token has expired.', code: 'expired' }, 401);
  }
  const preVideoRemaining = preCheck.video_reviews_remaining ?? 0;
  if (preVideoRemaining <= 0) {
    return json({ detail: 'No video reviews remaining. Purchase a Video Coaching or Video + Scan Bundle to generate a coaching video.', code: 'no_video_credits' }, 402);
  }

  // Acquire mutex to prevent concurrent double-spend
  const { acquired } = await acquireScanMutex(kv, token);
  if (!acquired) {
    return json({ detail: 'A request is already processing this token. Please try again in a moment.', code: 'concurrent_request' }, 429);
  }

  // Re-read token under the lock — state may have changed while we were acquiring.
  let tokenData;
  let creditDecremented = false;
  try {
    const lockedRaw = await kv.get(`token:${token}`);
    if (!lockedRaw) return json({ detail: 'Invalid or expired token.', code: 'invalid_token' }, 401);
    tokenData = JSON.parse(lockedRaw);

    if (new Date(tokenData.expires_at) < new Date()) {
      return json({ detail: 'Token has expired.', code: 'expired' }, 401);
    }
    const videoRemaining = tokenData.video_reviews_remaining ?? 0;
    if (videoRemaining <= 0) {
      return json({ detail: 'No video reviews remaining. Purchase a Video Coaching or Video + Scan Bundle to generate a coaching video.', code: 'no_video_credits' }, 402);
    }

    // Safe to decrement — we hold the mutex and just confirmed video_reviews > 0
    tokenData.video_reviews_remaining = videoRemaining - 1;
    const ttlSeconds = Math.max(
      Math.floor((new Date(tokenData.expires_at) - Date.now()) / 1000), 1
    );
    await kv.put(`token:${token}`, JSON.stringify(tokenData), { expirationTtl: ttlSeconds });
    creditDecremented = true;
  } finally {
    await releaseScanMutex(kv, token);
  }

  // Anything that fails past this point leaves the user without a video — refund the credit.
  let videoDelivered = false;
  try {
    return await runVideoReviewPipeline({
      kv, token, tokenData, resumeFile, jobDesc, formData, env,
      markDelivered: () => { videoDelivered = true; },
    });
  } finally {
    if (creditDecremented && !videoDelivered) {
      try { await refundVideoReviewCredit(kv, token); } catch (_) { /* best-effort */ }
    }
  }
}

async function refundVideoReviewCredit(kv, token) {
  const { acquired } = await acquireScanMutex(kv, token);
  if (!acquired) return;
  try {
    const raw = await kv.get(`token:${token}`);
    if (!raw) return;
    const td = JSON.parse(raw);
    td.video_reviews_remaining = (td.video_reviews_remaining || 0) + 1;
    td.last_refund_at = new Date().toISOString();
    const ttl = Math.max(Math.floor((new Date(td.expires_at) - Date.now()) / 1000), 1);
    await kv.put(`token:${token}`, JSON.stringify(td), { expirationTtl: ttl });
  } finally {
    await releaseScanMutex(kv, token);
  }
}

async function runVideoReviewPipeline({ kv, token, tokenData, resumeFile, jobDesc, formData, env, markDelivered }) {

  // Parse resume
  if (!resumeFile || typeof resumeFile === 'string') {
    return json({ detail: 'No resume file uploaded' }, 400);
  }

  const bytes = await resumeFile.arrayBuffer();
  const uploadValidation = validateResumeUpload(resumeFile, bytes);
  if (!uploadValidation.ok) {
    return uploadValidation.response;
  }
  const ext = uploadValidation.type;

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ detail: 'AI not configured' }, 500);

  let messages;
  if (ext === 'pdf') {
    const base64 = arrayBufferToBase64(bytes);
    messages = [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: buildVideoReviewPrompt(null, jobDesc) }
      ]
    }];
  } else if (ext === 'docx') {
    let resumeText;
    try {
      const result = await mammoth.extractRawText({ arrayBuffer: bytes });
      resumeText = result.value;
    } catch (e) {
      return json({ detail: `Could not parse DOCX: ${e.message}` }, 400);
    }
    if (!resumeText.trim()) {
      return json({ detail: 'Could not extract text from file. Try a PDF.' }, 400);
    }
    messages = [{ role: 'user', content: buildVideoReviewPrompt(resumeText, jobDesc) }];
  } else {
    return json({ detail: 'Unsupported file type. Please upload PDF or DOCX.' }, 400);
  }

  // Call Claude API
  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 4096, system: buildVideoReviewSystemPrompt(), messages }),
    });
  } catch (e) {
    return json({ detail: `API request failed: ${e.message}` }, 500);
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    const isPdfError = claudeRes.status === 400 ||
      errText.includes('Could not process') ||
      errText.includes('document') ||
      errText.includes('pdf');
    if (isPdfError) {
      return json({ detail: 'The uploaded PDF could not be read. Please ensure you are uploading a valid, uncorrupted PDF file.', code: 'invalid_pdf' }, 400);
    }
    return json({ detail: 'An error occurred while generating your video review. Please try again.', code: 'ai_error' }, 500);
  }

  const claudeData = await claudeRes.json();
  const rawText = claudeData.content?.[0]?.text || '';

  // Extract JSON — strip markdown fences, then find the outermost { } block
  let cleaned = rawText
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        result = JSON.parse(match[0]);
      } catch {
        return json({ detail: 'Failed to parse AI response as JSON', raw: cleaned.substring(0, 200) }, 500);
      }
    } else {
      return json({ detail: 'Failed to parse AI response as JSON', raw: cleaned.substring(0, 200) }, 500);
    }
  }

  result = sanitizeVideoReviewResult(result);

  // ── Video pipeline kickoff ────────────────────────────────────────────
  // Runs after script generation. If any step fails, we still return the
  // script — the user gets text coaching at minimum.
  let jobId = null;
  let _pipelineError = null;
  const heygenKey = env.HEYGEN_API_KEY;
  const avatarId  = env.HEYGEN_AVATAR_ID;
  const voiceId   = env.HEYGEN_VOICE_ID;

  if (heygenKey && avatarId && voiceId) {
    try {
      // Start HeyGen avatar video job with text + voice directly
      const heygenVideoId = await heygenStartJob(avatarId, result.script, voiceId, heygenKey);
      // 4. Write job record to KV; frontend polls /video-status?jobId=X
      jobId = crypto.randomUUID();
      const email = formData.get('email') || tokenData.email || '';
      await kv.put(`video:${jobId}`, JSON.stringify({
        status: 'processing',
        heygenVideoId,
        videoUrl: null,
        createdAt: new Date().toISOString(),
        token,
        email: email || null,
        name: result.name_extracted || null,
      }), { expirationTtl: 86400 });
      // HeyGen job started successfully — credit is consumed.
      markDelivered();
    } catch (_e) {
      // Video pipeline failed — degrade gracefully, return script only (credit will be refunded).
      jobId = null;
      _pipelineError = _e.message || String(_e);
    }
  } else {
    // No HeyGen configured — can't deliver a video, so refund and just return the script.
    _pipelineError = 'video pipeline not configured';
  }

  return json({ ...result, video_reviews_remaining: tokenData.video_reviews_remaining, job_id: jobId, pipeline_error: _pipelineError });
}

function buildVideoReviewSystemPrompt() {
  return `You are a professional female career coach who creates personalized video review scripts for job seekers. You have over 15 years of experience in career coaching, resume optimization, and ATS (Applicant Tracking System) strategy. You've helped thousands of candidates land roles at top companies.

Your video reviews are warm, encouraging, and honest. You speak directly to the candidate as if recording a personalized coaching video for them. Your tone is professional but approachable — like a trusted mentor who genuinely wants them to succeed.

RULES — NON-NEGOTIABLE:
- The script must be 150–225 words (approximately 60–90 seconds when spoken aloud).
- Always try to extract the candidate's first name from the resume. If you can find it, greet them by name.
- Identify exactly 2–3 specific strengths worth highlighting.
- Identify exactly 2–3 critical improvements they need to make.
- End with exactly one clear, actionable next step.
- Be specific — reference actual content from their resume, not generic advice.
- If a job description is provided, tailor your advice to that specific role.
- Do not use filler phrases like "I can see that" or "It looks like" excessively.

OUTPUT FORMAT — NON-NEGOTIABLE:
- Return ONLY a valid JSON object. No markdown fences, no preamble, no trailing text.
- Your response must be parseable by JSON.parse() with no pre-processing.`;
}

function buildVideoReviewPrompt(resumeText, jobDescription) {
  const jdSection = jobDescription?.trim()
    ? `\n## Job Description (tailor advice to this role)\n${jobDescription.trim()}\n` : '';
  const resumeSection = resumeText ? `\n## Resume\n${resumeText}\n` : '';

  return `Review the resume${resumeText ? ' below' : ' in the attached document'} and generate a personalized career coaching video script.
${jdSection}${resumeSection}
---

Respond with a JSON object following this exact schema:

{
  "script": "<the full 60-90 second coaching script, 150-225 words, written as spoken word>",
  "name_extracted": "<candidate's first name if found, or null>",
  "duration_estimate_seconds": <estimated spoken duration as integer, between 60-90>,
  "key_strengths": ["<strength 1>", "<strength 2>"],
  "improvements": ["<improvement 1>", "<improvement 2>"],
  "next_step": "<one clear actionable next step>"
}

Script structure:
1. Greeting — address the candidate by name if possible, and briefly introduce yourself as their career coach from "AT Score" (two words, always written and spoken as "AT Score" — never "ATScore" or "ATS core")
2. Strengths — highlight 2-3 things they're doing well (be specific, reference their actual experience)
3. Improvements — 2-3 critical changes that would significantly improve their resume's ATS performance and overall impact
4. Next step — one concrete action they should take right now

${jobDescription?.trim() ? 'Tailor all advice to the specific job description provided. Reference keywords and requirements from the role.' : 'Provide general ATS optimization and career advice based on their industry and experience level.'}

Return ONLY the JSON object, no other text.`;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': 'https://ats-optimizer.pages.dev',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
      'X-Frame-Options': 'DENY',
    },
  });
}
