/**
 * POST /rewrite — Token-gated resume rewrite
 * Form fields: resume (file), job_description (text), token (string)
 * Returns: { optimized_resume: string, scans_remaining: number }
 */

import mammoth from 'mammoth';

export async function onRequestPost(context) {
  const { request, env } = context;

  let formData;
  try { formData = await request.formData(); }
  catch { return json({ detail: 'Invalid form data' }, 400); }

  const token       = formData.get('token') || '';
  const resumeFile  = formData.get('resume');
  const jobDesc     = formData.get('job_description') || '';

  // Validate token
  const kv = env.TOKENS_KV;
  if (!kv) return json({ detail: 'Token system not configured', code: 'no_kv' }, 500);

  const raw = await kv.get(`token:${token}`);
  if (!raw) return json({ detail: 'Invalid or expired token. Please purchase a scan.', code: 'invalid_token' }, 401);

  const tokenData = JSON.parse(raw);

  if (new Date(tokenData.expires_at) < new Date()) {
    return json({ detail: 'Token has expired.', code: 'expired' }, 401);
  }
  if (tokenData.scans_remaining <= 0) {
    return json({ detail: 'No scans remaining on this token.', code: 'no_scans' }, 402);
  }

  // Decrement scan count
  tokenData.scans_remaining -= 1;
  const ttlSeconds = Math.max(
    Math.floor((new Date(tokenData.expires_at) - Date.now()) / 1000), 1
  );
  await kv.put(`token:${token}`, JSON.stringify(tokenData), { expirationTtl: ttlSeconds });

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
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16000, messages }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.text();
    return json({ detail: `AI error: ${err}` }, 500);
  }

  const claudeData = await claudeRes.json();
  const optimized  = claudeData.content?.[0]?.text?.trim() || '';

  return json({ optimized_resume: optimized, scans_remaining: tokenData.scans_remaining });
}

function buildRewritePrompt(resumeText, jobDescription) {
  const jdSection = jobDescription?.trim()
    ? `\n## Job Description\n${jobDescription.trim()}\n` : '';
  const resumeSection = resumeText ? `\n## Resume\n${resumeText}\n` : '';
  const jobNote = jobDescription?.trim() ? ', optimized for this specific role' : '';

  return `You are an expert resume writer and ATS specialist. Rewrite the resume${resumeText ? ' below' : ' in the attached document'} into a clean, ATS-optimized version.
${jdSection}${resumeSection}
---

Output ONLY the rewritten resume as plain text. No preamble, no commentary, no markdown.

Rules for the rewrite:
- Use standard section headers in ALL CAPS: CONTACT, SUMMARY, EXPERIENCE, EDUCATION, SKILLS, CERTIFICATIONS
- Keep all real experience, companies, dates, and facts — do not invent anything
- Improve phrasing with strong action verbs (Led, Built, Drove, Increased, Reduced, Managed)
- Add quantifiable achievements where the original is vague (e.g., "Led a team" → "Led a team of 8 engineers")
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
