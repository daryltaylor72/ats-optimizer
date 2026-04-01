/**
 * POST /rewrite — Token-gated resume rewrite
 * Form fields: resume (file), job_description (text), token (string)
 * Returns: { optimized_resume: string, scans_remaining: number }
 */

import mammoth from 'mammoth';
import { acquireScanMutex, releaseScanMutex } from './_shared.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let formData;
  try { formData = await request.formData(); }
  catch { return json({ detail: 'Invalid form data' }, 400); }

  const token       = formData.get('token') || '';
  const resumeFile  = formData.get('resume');
  const jobDesc     = formData.get('job_description') || '';
  const email       = (formData.get('email') || '').trim();

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
  // Two simultaneous requests could both pass the pre-check above — the mutex
  // ensures only one proceeds to decrement at a time.
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
  const ext   = (resumeFile.name || '').split('.').pop().toLowerCase();

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ detail: 'AI not configured' }, 500);

  let messages;
  if (ext === 'pdf') {
    const base64 = arrayBufferToBase64(bytes);
    messages = [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: buildRewritePrompt(null, jobDesc) }
      ]
    }];
  } else {
    const result = await mammoth.extractRawText({ arrayBuffer: bytes });
    messages = [{ role: 'user', content: buildRewritePrompt(result.value, jobDesc) }];
  }

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
    },
    body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 16000, system: buildRewriteSystemPrompt(), messages }),
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
    return json({ detail: 'An error occurred while rewriting your resume. Please try again.', code: 'ai_error' }, 500);
  }

  const claudeData = await claudeRes.json();
  const optimized  = claudeData.content?.[0]?.text?.trim() || '';

  // Send optimized resume email + capture lead
  const sendTo = email || tokenData.email;
  const debugErrors = [];
  if (sendTo) {
    if (env.RESEND_API_KEY) {
      try { await withRetry(() => sendRewriteEmail(env.RESEND_API_KEY, sendTo, optimized, tokenData.scans_remaining)); }
      catch (e) { debugErrors.push(`resend: ${e.message}`); }
    } else { debugErrors.push('resend: RESEND_API_KEY not set'); }
    if (env.AIRTABLE_ATS_SECRET_KEY) {
      try { await withRetry(() => captureAirtableLead(env.AIRTABLE_ATS_SECRET_KEY, { email: sendTo, plan: tokenData.plan, source: 'paid_scan', jobMatch: !!jobDesc?.trim() }, env)); }
      catch (e) { debugErrors.push(`airtable: ${e.message}`); }
    }
  } else { debugErrors.push('resend: no email address available'); }

  return json({ optimized_resume: optimized, scans_remaining: tokenData.scans_remaining, _debug: debugErrors });
}

/**
 * Retries an async function up to `maxAttempts` times with exponential backoff.
 * Only retries on transient failures (network errors or 5xx responses).
 * Throws the last error if all attempts are exhausted.
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

async function sendRewriteEmail(apiKey, to, optimizedResume, scansRemaining) {
  const scansText = scansRemaining >= 9000
    ? 'You have unlimited scans remaining.'
    : scansRemaining === 0
    ? 'You have used all your scans.'
    : `You have ${scansRemaining} scan${scansRemaining !== 1 ? 's' : ''} remaining on your account.`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">
    <table role="presentation" style="margin-bottom:32px;border-collapse:collapse;">
      <tr>
        <td style="padding-right:8px;vertical-align:middle;">
          <div style="width:32px;height:32px;background:#6c63ff;border-radius:6px;line-height:32px;text-align:center;font-size:16px;">📄</div>
        </td>
        <td style="vertical-align:middle;">
          <span style="color:#e8eaf0;font-size:16px;font-weight:600;">ATS Resume Optimizer</span>
        </td>
      </tr>
    </table>

    <h1 style="color:#e8eaf0;font-size:22px;margin:0 0 12px;">Your Optimized Resume is Ready</h1>
    <p style="color:#9299b0;font-size:14px;line-height:1.6;margin:0 0 24px;">Your AI-rewritten, ATS-optimized resume is below. Copy it into your preferred document editor and save as a clean .docx or .txt file.</p>

    <div style="background:#111318;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;margin-bottom:24px;">
      <p style="color:#9299b0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 16px;">Optimized Resume</p>
      <pre style="color:#e8eaf0;font-size:13px;line-height:1.7;white-space:pre-wrap;word-wrap:break-word;margin:0;font-family:ui-monospace,'Cascadia Code','Source Code Pro',Menlo,monospace;">${optimizedResume.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
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
      subject: 'Your ATS-Optimized Resume is Ready',
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

function buildRewriteSystemPrompt() {
  return `You are a senior technical resume writer who specializes in ATS optimization. You have written and reviewed over 10,000 resumes for candidates at every level from entry-level to C-suite across tech, finance, healthcare, and government sectors.

Your rewrites consistently help candidates pass ATS screening. Follow these rules without exception:

ACCURACY — NON-NEGOTIABLE
- Never fabricate, invent, or embellish. Do not add companies, titles, dates, degrees, certifications, or skills that are not in the original.
- For metrics and numbers: if the original has a number, keep it. If no number exists, insert a bracketed placeholder: [X], [team size], [%], [dollar amount] — so the candidate can fill in their real figure.
- Example: "managed a team" → "managed a cross-functional team of [team size] engineers"
- Example: "reduced costs" → "reduced costs by [X]%, saving approximately [$amount] annually"
- Improve phrasing and structure. Facts must be faithful; placeholders make gaps explicit.

OUTPUT FORMAT — NON-NEGOTIABLE
- Output ONLY the rewritten resume as plain text. Nothing else.
- Do not begin with "Here is your rewritten resume" or any other preamble.
- Do not end with commentary, notes, or explanation.
- Do not use markdown (no **, no #, no -, no *).
- Your response must begin with the first line of the resume (typically the candidate's name) and end with the last line of the resume.

ATS FORMATTING RULES
- Use ALL CAPS section headers: CONTACT, SUMMARY, EXPERIENCE, EDUCATION, SKILLS, CERTIFICATIONS (include only sections present in the original)
- No tables, columns, text boxes, headers/footers, or graphics — these break ATS parsers
- No special characters in bullet points — use a plain hyphen (-) or omit bullet markers entirely
- Dates must follow a consistent format throughout: "Month YYYY – Month YYYY" or "YYYY – YYYY"
- Phone numbers: no parentheses — use dashes: 555-867-5309

QUALITY STANDARDS
- Open each bullet with a strong past-tense action verb (Led, Built, Drove, Reduced, Increased, Designed, Launched, Managed, Negotiated, Delivered)
- Keep bullets to 1–2 lines; cut filler words
- Tailor keyword density to the job description when one is provided, using exact phrases from the JD`;
}

function buildRewritePrompt(resumeText, jobDescription) {
  const jdSection = jobDescription?.trim()
    ? `\n## Job Description\n${jobDescription.trim()}\n` : '';
  const resumeSection = resumeText ? `\n## Resume\n${resumeText}\n` : '';
  const jobNote = jobDescription?.trim() ? ', optimized for this specific role' : '';

  return `Rewrite the resume${resumeText ? ' below' : ' in the attached document'} into a clean, ATS-optimized version.
${jdSection}${resumeSection}
---

Output ONLY the rewritten resume as plain text. No preamble, no commentary, no markdown.

Rules for the rewrite:
- Use standard section headers in ALL CAPS: CONTACT, SUMMARY, EXPERIENCE, EDUCATION, SKILLS, CERTIFICATIONS
- Keep all real experience, companies, dates, and facts — do not invent anything
- Improve phrasing with strong action verbs (Led, Built, Drove, Increased, Reduced, Managed)
- Where metrics are missing, insert bracketed placeholders the candidate fills in: [X]%, [team size], [$amount], [project name]
  Example: "Led a team" → "Led a cross-functional team of [team size] engineers"
  Example: "Improved performance" → "Improved system performance by [X]%, reducing [metric] from [before] to [after]"
- Remove tables, columns, graphics, and any formatting that ATS systems cannot parse
- Format dates consistently: "Month Year – Month Year" (e.g., "January 2022 – March 2024")
- Include keywords from the job description naturally${jobNote}
- Keep bullets concise: 1–2 lines each
- Aim for 1–2 pages depending on experience level

Output the rewritten resume now:`;
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
