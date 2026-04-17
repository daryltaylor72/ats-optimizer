/**
 * POST /interview-prep — Token-gated interview prep Q&A generator
 * Form fields: resume (file), job_description (text), token (string), email (text), interview_type (text)
 * Returns: { interview_prep: string, scans_remaining: number }
 */

import mammoth from 'mammoth';
import {
  createTokenSessionCookie,
  getSessionSecret,
  readTokenSession,
} from './_auth.js';
import { acquireScanMutex, releaseScanMutex } from './_shared.js';
import { applyRateLimit, sanitizePlainText, validateMultipartSize, validateResumeUpload } from './_upload-security.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const sizeGuard = validateMultipartSize(request);
  if (sizeGuard) {
    return sizeGuard;
  }

  const rateLimitResponse = await applyRateLimit(
    env.TOKENS_KV,
    request,
    'interview-prep',
    20,
    3600,
    'Too many interview prep requests. Please try again in an hour.'
  );
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  let formData;
  try { formData = await request.formData(); }
  catch { return json({ detail: 'Invalid form data' }, 400); }

  const submittedToken = (formData.get('token') || '').trim();
  const tokenSession = await readTokenSession(request, env);
  const token         = submittedToken || tokenSession?.token || '';
  const resumeFile    = formData.get('resume');
  const jobDesc       = formData.get('job_description') || '';
  const email         = (formData.get('email') || '').trim();
  const interviewType = (formData.get('interview_type') || 'general').trim();

  // Validate token
  const kv = env.TOKENS_KV;
  if (!kv) return json({ detail: 'Token system not configured', code: 'no_kv' }, 500);

  // Fast pre-check before acquiring mutex — avoids the 50ms lock delay for
  // clearly invalid tokens (bad token, expired, already at 0 scans).
  const preCheckRaw = await kv.get(`token:${token}`);
  if (!preCheckRaw) return json({ detail: 'Invalid or expired token. Please purchase a scan.', code: 'invalid_token' }, 401);
  const preCheck = JSON.parse(preCheckRaw);
  if (new Date(preCheck.expires_at) < new Date()) {
    return json({ detail: 'Token has expired.', code: 'expired' }, 401);
  }
  if (preCheck.scans_remaining <= 0) {
    return json({ detail: 'No scans remaining on this token.', code: 'no_scans' }, 402);
  }

  // Acquire mutex to prevent concurrent double-spend of the same scan.
  const { acquired } = await acquireScanMutex(kv, token);
  if (!acquired) {
    return json({ detail: 'A request is already processing this token. Please try again in a moment.', code: 'concurrent_request' }, 429);
  }

  // Re-read token under the lock — state may have changed while we were acquiring.
  let tokenData;
  try {
    const lockedRaw = await kv.get(`token:${token}`);
    if (!lockedRaw) return json({ detail: 'Invalid or expired token. Please purchase a scan.', code: 'invalid_token' }, 401);
    tokenData = JSON.parse(lockedRaw);

    if (new Date(tokenData.expires_at) < new Date()) {
      return json({ detail: 'Token has expired.', code: 'expired' }, 401);
    }
    if (tokenData.scans_remaining <= 0) {
      return json({ detail: 'No scans remaining on this token.', code: 'no_scans' }, 402);
    }

    // Safe to decrement — we hold the mutex and just confirmed scans > 0
    tokenData.scans_remaining -= 1;
    const ttlSeconds = Math.max(
      Math.floor((new Date(tokenData.expires_at) - Date.now()) / 1000), 1
    );
    await kv.put(`token:${token}`, JSON.stringify(tokenData), { expirationTtl: ttlSeconds });
  } finally {
    // Always release — even if an early return fires above, finally still runs
    await releaseScanMutex(kv, token);
  }

  // Parse resume
  if (!resumeFile || typeof resumeFile === 'string') {
    return json({ detail: 'No resume file' }, 400);
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
        { type: 'text', text: buildInterviewPrompt(null, jobDesc, interviewType) }
      ]
    }];
  } else {
    const result = await mammoth.extractRawText({ arrayBuffer: bytes });
    messages = [{ role: 'user', content: buildInterviewPrompt(result.value, jobDesc, interviewType) }];
  }

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
    },
    body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 6000, system: buildInterviewSystemPrompt(), messages }),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    const isPdfError = claudeRes.status === 400 ||
      errText.includes('Could not process') ||
      errText.includes('document') ||
      errText.includes('pdf');
    if (isPdfError) {
      return json({ detail: 'The uploaded PDF could not be read. Please ensure you are uploading a valid, uncorrupted PDF file.', code: 'invalid_pdf' }, 400);
    }
    return json({ detail: 'An error occurred while generating your interview prep. Please try again.', code: 'ai_error' }, 500);
  }

  const claudeData = await claudeRes.json();
  const interviewPrep = sanitizePlainText(claudeData.content?.[0]?.text?.trim() || '', 20000);

  // Send email + capture lead
  const sendTo = email || tokenData.email;
  if (sendTo) {
    if (env.RESEND_API_KEY) {
      try { await withRetry(() => sendInterviewPrepEmail(env.RESEND_API_KEY, sendTo, interviewPrep, tokenData.scans_remaining)); }
      catch (e) { console.error('[interview-prep] Failed to send interview prep email:', e); }
    } else {
      console.error('[interview-prep] RESEND_API_KEY not set');
    }
    if (env.AIRTABLE_ATS_SECRET_KEY) {
      try { await withRetry(() => captureAirtableLead(env.AIRTABLE_ATS_SECRET_KEY, { email: sendTo, plan: tokenData.plan, source: 'interview_prep', jobMatch: !!jobDesc?.trim() }, env)); }
      catch (e) { console.error('[interview-prep] Failed to capture Airtable lead:', e); }
    }
  } else {
    console.error('[interview-prep] No email address available for delivery');
  }

  const headers = {};
  const secret = getSessionSecret(env);
  if (secret && token) {
    headers['Set-Cookie'] = await createTokenSessionCookie(token, secret);
  }

  return json({ interview_prep: interviewPrep, scans_remaining: tokenData.scans_remaining }, 200, headers);
}

/**
 * Retries an async function up to `maxAttempts` times with exponential backoff.
 */
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 300) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, baseDelayMs * attempt));
      }
    }
  }
  throw lastErr;
}

async function sendInterviewPrepEmail(apiKey, to, interviewPrep, scansRemaining) {
  const scansText = scansRemaining >= 9000
    ? 'You have unlimited scans remaining.'
    : scansRemaining === 0
    ? 'You have used all your scans.'
    : `You have ${scansRemaining} scan${scansRemaining !== 1 ? 's' : ''} remaining on your account.`;

  // Convert Q&A text to basic HTML rows for email
  const lines = interviewPrep.split('\n');
  let emailBody = '';
  let insideAnswer = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { emailBody += '<br>'; continue; }
    if (/^Q\d+:/i.test(trimmed)) {
      insideAnswer = false;
      emailBody += `<p style="color:#e8eaf0;font-size:14px;font-weight:600;margin:20px 0 6px;">${trimmed.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    } else if (/^A:/i.test(trimmed)) {
      insideAnswer = true;
      emailBody += `<p style="color:#9299b0;font-size:13px;line-height:1.7;margin:0 0 4px;">${trimmed.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    } else if (insideAnswer) {
      emailBody += `<p style="color:#9299b0;font-size:13px;line-height:1.7;margin:0 0 4px;">${trimmed.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    } else {
      emailBody += `<p style="color:#9299b0;font-size:13px;line-height:1.7;margin:0 0 4px;">${trimmed.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    }
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">
    <table role="presentation" style="margin-bottom:32px;border-collapse:collapse;">
      <tr>
        <td style="padding-right:8px;vertical-align:middle;">
          <div style="width:32px;height:32px;background:#6c63ff;border-radius:6px;line-height:32px;text-align:center;font-size:16px;">🎯</div>
        </td>
        <td style="vertical-align:middle;">
          <span style="color:#e8eaf0;font-size:16px;font-weight:600;">ATS Resume Optimizer</span>
        </td>
      </tr>
    </table>

    <h1 style="color:#e8eaf0;font-size:22px;margin:0 0 12px;">Your Interview Prep Guide is Ready</h1>
    <p style="color:#9299b0;font-size:14px;line-height:1.6;margin:0 0 24px;">Your personalized interview questions and sample answers are below, tailored to your background and the specific role you're targeting.</p>

    <div style="background:#111318;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;margin-bottom:24px;">
      <p style="color:#9299b0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 16px;">Interview Q&amp;A Guide</p>
      ${emailBody}
    </div>

    <p style="color:#9299b0;font-size:13px;margin:0 0 32px;">${scansText}</p>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;text-align:center;">
      <p style="color:#5a6080;font-size:12px;margin:0 0 6px;">ATScore · <a href="https://atscore.ai" style="color:#6c63ff;text-decoration:none;">atscore.ai</a> · <a href="mailto:support@atscore.ai" style="color:#6c63ff;text-decoration:none;">support@atscore.ai</a></p>
      <p style="color:#5a6080;font-size:11px;margin:0;">If you didn't receive this email, check your spam or promotions folder.</p>
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
      subject: 'Your Interview Prep Guide is Ready',
      html,
    }),
  });
  if (!r.ok) throw new Error(await r.text());
}

async function captureAirtableLead(apiKey, { email, plan, source, jobMatch }, env) {
  const baseId  = env.AIRTABLE_BASE_ID  || 'appJkfL4EoaSxq8GC';
  const tableId = env.AIRTABLE_TABLE_ID || 'tblxDbnavxmdWozc5';
  const res = await fetch(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        'Email': email,
        'Plan': plan,
        'Source': source,
        'Job Match Mode': !!jobMatch,
        'Date': new Date().toISOString(),
      }
    }),
  });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`);
}

function buildInterviewSystemPrompt() {
  return `You are a senior hiring manager and career coach with 15 years of experience conducting and preparing candidates for interviews across tech, business, and healthcare. You know exactly what interviewers are looking for and how to help candidates answer questions that get offers.`;
}

function buildInterviewPrompt(resumeText, jobDescription, interviewType) {
  const jdSection = jobDescription?.trim()
    ? `\n## Job Description\n${jobDescription.trim()}\n` : '';
  const resumeSection = resumeText ? `\n## Resume\n${resumeText}\n` : '';

  const typeFocus = {
    behavioral: 'Focus heavily on behavioral questions using the STAR method (Situation, Task, Action, Result). Include more examples of navigating challenges, teamwork, and leadership situations.',
    technical: 'Focus heavily on role-specific technical and situational questions that assess the candidate\'s hands-on skills and problem-solving approach for this specific role.',
    general: 'Include a balanced mix of behavioral, technical/role-specific, and situational questions.',
  }[interviewType] || 'Include a balanced mix of behavioral, technical/role-specific, and situational questions.';

  return `Analyze the resume${resumeText ? ' below' : ' in the attached document'} and the job description carefully, then generate a personalized interview prep guide.
${jdSection}${resumeSection}
---

${typeFocus}

Generate 8-10 tailored interview questions based on THIS candidate's actual background and the specific role. For each question, provide a strong sample answer drawn from the candidate's real experience shown in the resume.

Include this mix:
- 1 "Tell me about yourself" opener (Q1 always)
- 2-3 behavioral questions using STAR method
- 2-3 role-specific or technical questions tied to the job description
- 1-2 situational questions ("How would you handle...")

Format STRICTLY as:
Q1: [question]
A: [answer - 2-3 paragraphs drawing from candidate's actual background]

Q2: [question]
A: [answer]

(continue through Q8-Q10)

Rules:
- Answers must reference the candidate's actual experience from their resume — not generic advice
- Each answer should be 2-3 solid paragraphs in first-person voice, as if the candidate is speaking
- Behavioral answers must follow STAR method (name the situation, task, action, result)
- Make answers specific and compelling — something an interviewer would remember
- Output ONLY the Q&A — no intro sentence, no conclusion, no commentary`;
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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://ats-optimizer.pages.dev',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      ...extraHeaders,
    },
  });
}
