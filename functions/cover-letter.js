/**
 * POST /cover-letter — Token-gated cover letter generator
 * Form fields: resume (file), job_description (text), token (string), email (text),
 *              company_name (text, optional), role_title (text, optional)
 * Returns: { cover_letter: string, scans_remaining: number }
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
  const companyName = (formData.get('company_name') || '').trim();
  const roleTitle   = (formData.get('role_title') || '').trim();

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
        { type: 'text', text: buildCoverLetterPrompt(null, jobDesc, companyName, roleTitle) }
      ]
    }];
  } else {
    const result = await mammoth.extractRawText({ arrayBuffer: bytes });
    messages = [{ role: 'user', content: buildCoverLetterPrompt(result.value, jobDesc, companyName, roleTitle) }];
  }

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
    },
    body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 4000, system: buildCoverLetterSystemPrompt(), messages }),
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
    return json({ detail: 'An error occurred while generating your cover letter. Please try again.', code: 'ai_error' }, 500);
  }

  const claudeData = await claudeRes.json();
  const coverLetter = claudeData.content?.[0]?.text?.trim() || '';

  // Send cover letter email + capture lead
  const sendTo = email || tokenData.email;
  const debugErrors = [];
  if (sendTo) {
    if (env.RESEND_API_KEY) {
      try { await withRetry(() => sendCoverLetterEmail(env.RESEND_API_KEY, sendTo, coverLetter, tokenData.scans_remaining, companyName, roleTitle)); }
      catch (e) { debugErrors.push(`resend: ${e.message}`); }
    } else { debugErrors.push('resend: RESEND_API_KEY not set'); }
    if (env.AIRTABLE_ATS_SECRET_KEY) {
      try { await withRetry(() => captureAirtableLead(env.AIRTABLE_ATS_SECRET_KEY, { email: sendTo, plan: tokenData.plan, source: 'cover_letter', jobMatch: !!jobDesc?.trim() }, env)); }
      catch (e) { debugErrors.push(`airtable: ${e.message}`); }
    }
  } else { debugErrors.push('resend: no email address available'); }

  return json({ cover_letter: coverLetter, scans_remaining: tokenData.scans_remaining, _debug: debugErrors });
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

async function sendCoverLetterEmail(apiKey, to, coverLetter, scansRemaining, companyName, roleTitle) {
  const scansText = scansRemaining >= 9000
    ? 'You have unlimited scans remaining.'
    : scansRemaining === 0
    ? 'You have used all your scans.'
    : `You have ${scansRemaining} scan${scansRemaining !== 1 ? 's' : ''} remaining on your account.`;

  const roleInfo = [roleTitle, companyName].filter(Boolean).join(' at ');
  const subjectSuffix = roleInfo ? ` — ${roleInfo}` : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">
    <table role="presentation" style="margin-bottom:32px;border-collapse:collapse;">
      <tr>
        <td style="padding-right:8px;vertical-align:middle;">
          <div style="width:32px;height:32px;background:#6c63ff;border-radius:6px;line-height:32px;text-align:center;font-size:16px;">✉️</div>
        </td>
        <td style="vertical-align:middle;">
          <span style="color:#e8eaf0;font-size:16px;font-weight:600;">ATS Resume Optimizer</span>
        </td>
      </tr>
    </table>

    <h1 style="color:#e8eaf0;font-size:22px;margin:0 0 12px;">Your Cover Letter is Ready</h1>
    <p style="color:#9299b0;font-size:14px;line-height:1.6;margin:0 0 24px;">Your AI-written cover letter is below. Copy it into your preferred document editor, add your salutation (e.g. "Dear Hiring Manager,"), and customize as needed.</p>

    ${roleInfo ? `<p style="color:#6c63ff;font-size:13px;font-weight:600;margin:0 0 20px;">Tailored for: ${roleInfo.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>` : ''}

    <div style="background:#111318;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;margin-bottom:24px;">
      <p style="color:#9299b0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 16px;">Cover Letter</p>
      <pre style="color:#e8eaf0;font-size:13px;line-height:1.7;white-space:pre-wrap;word-wrap:break-word;margin:0;font-family:ui-monospace,'Cascadia Code','Source Code Pro',Menlo,monospace;">${coverLetter.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
    </div>

    <p style="color:#9299b0;font-size:13px;margin:0 0 32px;">${scansText}</p>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;text-align:center;">
      <p style="color:#5a6080;font-size:12px;margin:0 0 6px;">DeepTier Labs · <a href="https://atscore.ai" style="color:#6c63ff;text-decoration:none;">atscore.ai</a> · <a href="mailto:support@deeptierlabs.com" style="color:#6c63ff;text-decoration:none;">support@deeptierlabs.com</a></p>
      <p style="color:#5a6080;font-size:11px;margin:0;">If you didn't receive this email, check your spam or promotions folder.</p>
    </div>
  </div>
</body>
</html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'ATS Optimizer <results@deeptierlabs.com>',
      reply_to: ['support@deeptierlabs.com'],
      to: [to],
      subject: `Your Cover Letter is Ready${subjectSuffix}`,
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

function buildCoverLetterSystemPrompt() {
  return `You are an expert career coach and professional writer. You write compelling cover letters that get interviews. Your letters are personalized, achievement-focused, and avoid generic phrases.`;
}

function buildCoverLetterPrompt(resumeText, jobDescription, companyName, roleTitle) {
  const roleSection = roleTitle ? `Role: ${roleTitle}` : '';
  const companySection = companyName ? `Company: ${companyName}` : '';
  const contextLines = [roleSection, companySection].filter(Boolean).join('\n');
  const contextBlock = contextLines ? `\n## Target Position\n${contextLines}\n` : '';
  const jdSection = jobDescription?.trim()
    ? `\n## Job Description\n${jobDescription.trim()}\n` : '';
  const resumeSection = resumeText ? `\n## Resume\n${resumeText}\n` : '';

  return `Write a compelling cover letter${resumeText ? ' based on the resume below' : ' based on the attached resume'}.
${contextBlock}${jdSection}${resumeSection}
---

Instructions:
- Write 3-4 paragraphs, approximately 300-400 words total
- Open with a strong hook — do NOT start with "I am applying for..." or "I am writing to express my interest..."
- Highlight 2-3 specific achievements from the resume that are most relevant to this role
- Show authentic enthusiasm for the opportunity (not generic filler phrases)
- Close with a confident, specific call to action
- Output ONLY the cover letter body text — no subject line, no salutation (the candidate will add "Dear Hiring Manager," themselves), start directly from the opening line
- Do NOT use markdown, bullet points, or any special formatting — plain paragraphs only
- Keep the tone professional but human and conversational

Output the cover letter now:`;
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
