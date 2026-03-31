/**
 * Cloudflare Pages Function — POST /analyze
 * Accepts multipart form: resume (PDF or DOCX) + job_description (text)
 * Returns JSON with ATS score, issues, recommendations, optimized_resume text
 */

import mammoth from 'mammoth';

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: 'API key not configured' }, 500);
  }

  // Rate limiting: 5 free analyses per IP per hour
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = `ratelimit:analyze:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
  const kv = env.TOKENS_KV;
  if (kv) {
    const count = parseInt(await kv.get(rateKey) || '0');
    if (count >= 15) {
      return json({ detail: 'Too many requests. Please try again in an hour, or purchase a plan for unlimited access.' }, 429);
    }
    await kv.put(rateKey, String(count + 1), { expirationTtl: 3600 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ detail: 'Invalid form data' }, 400);
  }

  const resumeFile = formData.get('resume');
  const jobDescription = formData.get('job_description') || '';
  const includeRewrite = formData.get('include_rewrite') === 'true';
  const email = (formData.get('email') || '').trim();
  const token = (formData.get('token') || '').trim();

  // Look up plan from token if provided (so paid users are logged correctly)
  let userPlan = 'free';
  if (token && kv) {
    const raw = await kv.get(`token:${token}`);
    if (raw) userPlan = JSON.parse(raw).plan || 'free';
  }

  if (!resumeFile || typeof resumeFile === 'string') {
    return json({ detail: 'No resume file uploaded' }, 400);
  }

  const filename = resumeFile.name || 'resume';
  const ext = filename.split('.').pop().toLowerCase();
  const bytes = await resumeFile.arrayBuffer();

  if (bytes.byteLength > 10 * 1024 * 1024) {
    return json({ detail: 'File too large (max 10MB)' }, 400);
  }

  // Build Claude messages
  let messages;

  if (ext === 'pdf') {
    // Use Claude's native PDF document support
    const base64 = arrayBufferToBase64(bytes);
    messages = [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 }
        },
        { type: 'text', text: buildPrompt(null, jobDescription, includeRewrite) }
      ]
    }];
  } else if (ext === 'docx' || ext === 'doc') {
    // Extract text from DOCX with mammoth
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
    messages = [{
      role: 'user',
      content: buildPrompt(resumeText, jobDescription, includeRewrite)
    }];
  } else {
    return json({ detail: 'Unsupported file type. Please upload PDF or DOCX.' }, 400);
  }

  // Call Claude API — Opus primary, Sonnet fallback if overloaded
  const MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6'];
  let claudeResponse;

  for (const model of MODELS) {
    let overloaded = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model,
            max_tokens: includeRewrite ? 16000 : 8192,
            system: buildSystemPrompt(),
            messages
          })
        });
      } catch (e) {
        if (attempt === 2) { overloaded = true; break; }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      if (claudeResponse.status === 529 || claudeResponse.status === 503) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
        overloaded = true;
      }
      break;
    }
    // If this model is overloaded and there's a fallback, try next model
    if (overloaded && model !== MODELS[MODELS.length - 1]) continue;
    if (!overloaded) break;
  }

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    if (claudeResponse.status === 529 || claudeResponse.status === 503) {
      return json({ detail: 'The AI service is temporarily busy. Please try again in a few seconds.' }, 503);
    }
    // Detect corrupt/unreadable PDF without leaking internal provider details
    const isPdfError = claudeResponse.status === 400 ||
      errText.includes('Could not process') ||
      errText.includes('document') ||
      errText.includes('pdf');
    if (isPdfError) {
      return json({ detail: 'The uploaded PDF could not be read. Please ensure you are uploading a valid, uncorrupted PDF file.' }, 400);
    }
    return json({ detail: 'An error occurred while analyzing your resume. Please try again.' }, 500);
  }

  const claudeData = await claudeResponse.json();
  const rawText = claudeData.content?.[0]?.text || '';

  // Extract JSON — strip markdown fences, then find the outermost { } block
  let cleaned = rawText
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  // If still not valid JSON, try to extract the first complete {...} object
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

  // Send results email + capture lead
  const isPaidUser = userPlan !== 'free';
  const debugErrors = [];
  if (email) {
    const isJobMatch = !!(jobDescription?.trim());
    if (env.RESEND_API_KEY) {
      try { await sendAnalysisEmail(env.RESEND_API_KEY, email, result, isPaidUser, token); }
      catch (e) { debugErrors.push(`resend: ${e.message}`); }
    } else { debugErrors.push('resend: RESEND_API_KEY not set'); }
    if (env.AIRTABLE_ATS_SECRET_KEY) {
      try { await captureAirtableLead(env.AIRTABLE_ATS_SECRET_KEY, { email, plan: userPlan, score: result.score, grade: result.grade, source: userPlan === 'free' ? 'free_scan' : 'paid_scan', jobMatch: isJobMatch }); }
      catch (e) { debugErrors.push(`airtable: ${e.message}`); }
    } else { debugErrors.push('airtable: AIRTABLE_ATS_SECRET_KEY not set'); }
  }

  return json({ ...result, _debug: debugErrors }, 200);
}

async function sendAnalysisEmail(apiKey, to, result, isPaidUser = false, token = '') {
  const score = result.score || 0;
  const grade = result.grade || '?';
  const summary = result.summary || '';
  const criticalCount = (result.critical_issues || []).length;
  const color = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:24px;">
        <div style="width:32px;height:32px;background:#6c63ff;border-radius:6px;display:inline-block;line-height:32px;text-align:center;font-size:16px;">📄</div>
        <span style="color:#e8eaf0;font-size:16px;font-weight:600;">ATS Resume Optimizer</span>
      </div>
      <div style="width:110px;height:110px;border-radius:50%;border:10px solid ${color};text-align:center;padding-top:20px;box-sizing:border-box;display:inline-block;margin-bottom:16px;">
        <div style="font-size:36px;font-weight:700;color:${color};line-height:1;">${score}</div>
        <div style="font-size:12px;color:#9299b0;margin-top:4px;">Grade ${grade}</div>
      </div>
      <h1 style="color:#e8eaf0;font-size:22px;margin:0 0 12px;">Your ATS Score: ${score}/100</h1>
      <p style="color:#9299b0;font-size:14px;line-height:1.6;margin:0 auto;max-width:440px;">${summary}</p>
    </div>

    <div style="background:#111318;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;margin-bottom:24px;">
      <p style="color:#e8eaf0;font-weight:600;margin:0 0 8px;">⚠️ ${criticalCount} Critical Issue${criticalCount !== 1 ? 's' : ''} Found</p>
      <p style="color:#9299b0;font-size:14px;margin:0;line-height:1.6;">Your resume has formatting and keyword issues that may cause ATS systems to filter it out before a human ever sees it.</p>
    </div>

    ${isPaidUser ? `
    <div style="background:#111318;border:1px solid rgba(108,99,255,0.3);border-radius:12px;padding:20px;margin-bottom:32px;">
      <p style="color:#9299b0;font-size:13px;margin:0;line-height:1.6;">
        \u{1F4A1} <strong style="color:#e8eaf0;">Tip:</strong> For best results on your next scan, paste the job description — your resume will be rewritten to match that specific role.
      </p>
    </div>

    <div style="text-align:center;margin-bottom:32px;">
      <a href="https://ats.deeptierlabs.com/tool${token ? '?token=' + token : ''}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">
        Run Another Scan \u2192
      </a>
    </div>` : `
    <div style="background:#111318;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;margin-bottom:32px;">
      <p style="color:#9299b0;font-size:13px;margin:0 0 16px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">What you unlock with a paid scan:</p>
      <div style="color:#e8eaf0;font-size:14px;line-height:2;">
        \u2705 Full category breakdown (6 areas scored)<br>
        \u2705 All critical issues &amp; fixes<br>
        \u2705 Keyword gap analysis<br>
        \u2705 AI-rewritten resume, ATS-optimized<br>
        \u2705 Instant download
      </div>
    </div>

    <div style="text-align:center;margin-bottom:32px;">
      <a href="https://ats.deeptierlabs.com/#pricing" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">
        Unlock Full Analysis \u2014 Starting at $5
      </a>
      <p style="color:#5a6080;font-size:12px;margin-top:12px;">Secure payment via Stripe \u00b7 Pro plan billed monthly, cancel anytime</p>
    </div>`}

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;text-align:center;">
      <p style="color:#5a6080;font-size:12px;margin:0 0 8px;">DeepTier Labs · <a href="https://ats.deeptierlabs.com" style="color:#6c63ff;text-decoration:none;">ats.deeptierlabs.com</a> · <a href="mailto:support@deeptierlabs.com" style="color:#6c63ff;text-decoration:none;">support@deeptierlabs.com</a></p>
      <p style="color:#5a6080;font-size:11px;margin:0;">If you didn't receive this email, check your spam or promotions folder.</p>
    </div>
  </div>
</body>
</html>`;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'ATS Optimizer <results@deeptierlabs.com>',
      reply_to: ['support@deeptierlabs.com'],
      to: [to],
      subject: `Your ATS Score: ${score}/100 — Grade ${grade}`,
      html,
    }),
  });
  if (!resendRes.ok) {
    const err = await resendRes.text();
    throw new Error(`Resend ${resendRes.status}: ${err}`);
  }
}

async function captureAirtableLead(apiKey, { email, plan, score, grade, source, jobMatch }) {
  const atRes = await fetch('https://api.airtable.com/v0/appJkfL4EoaSxq8GC/tblxDbnavxmdWozc5', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        'Email': email,
        'Plan': plan,
        'ATS Score': score || 0,
        'Grade': grade || '',
        'Source': source,
        'Job Match Mode': !!jobMatch,
        'Date': new Date().toISOString(),
      }
    }),
  });
  if (!atRes.ok) {
    const err = await atRes.text();
    throw new Error(`Airtable ${atRes.status}: ${err}`);
  }
}

function buildSystemPrompt() {
  return `You are a senior ATS (Applicant Tracking System) specialist with deep expertise in enterprise recruiting platforms including Taleo, Workday, Greenhouse, iCIMS, and Lever. You have reviewed and scored over 50,000 resumes.

Your role is to provide honest, calibrated, actionable ATS analysis. Follow these rules without exception:

SCORING CALIBRATION
- Score honestly. Most real-world resumes score between 40 and 72.
- Reserve 85–100 only for resumes that are genuinely exceptional: clean parse, strong keywords, quantified achievements, correct formatting.
- A resume with any tables, columns, graphics, or missing contact info cannot score above 70.
- A resume missing quantified achievements cannot score above 78.

KEYWORD MATCHING (when a job description is provided)
- Extract keywords verbatim from the job description — exact phrases and skill names only.
- Do not substitute synonyms. If the JD says "Agile" do not report "Scrum" as a gap unless "Scrum" also appears.
- Report only keywords that are genuinely missing from the resume.

OUTPUT FORMAT
- Return ONLY a valid JSON object. No markdown fences, no preamble, no explanation, no trailing text.
- Your response must be parseable by JSON.parse() with no pre-processing.
- If you cannot analyze the document for any reason, return: {"score":0,"grade":"F","summary":"Unable to analyze document.","categories":[],"critical_issues":["Document could not be parsed"],"recommendations":[],"keyword_gaps":[],"optimized_resume":null}

RECOMMENDATIONS
- Be specific and actionable. Never write "improve your resume" or "add more details."
- Bad: "Add more keywords." Good: "Add 'stakeholder management' and 'risk mitigation' to your Skills section — both appear in the job description."`;
}

function buildPrompt(resumeText, jobDescription, includeRewrite) {
  const jdSection = jobDescription?.trim()
    ? `\n## Job Description to Match Against\n${jobDescription.trim()}\n`
    : '';

  const resumeSection = resumeText
    ? `\n## Resume Text\n${resumeText}\n`
    : '';

  const jobMatchNote = jobDescription?.trim()
    ? ', and optimize for the job description'
    : '';

  const rewriteField = includeRewrite
    ? `  "optimized_resume": "<full rewritten resume, plain text, ATS-optimized>"`
    : `  "optimized_resume": null`;

  const rewriteInstruction = includeRewrite
    ? `\nFor optimized_resume: rewrite the full resume in clean ATS-friendly plain text. Use standard section headers (CONTACT, SUMMARY, EXPERIENCE, EDUCATION, SKILLS). Keep all real experience but improve phrasing, add relevant keywords${jobMatchNote}. Format dates consistently. Use strong action verbs.`
    : `\nSet optimized_resume to null.`;

  return `Analyze the resume${resumeText ? ' below' : ' in the attached document'} and provide a detailed ATS optimization report.
${jdSection}${resumeSection}
---

Respond with a JSON object following this exact schema:

{
  "score": <integer 0-100>,
  "grade": <"A" | "B" | "C" | "D" | "F">,
  "summary": "<2-3 sentence overall assessment>",
  "categories": [
    {
      "name": "<category name>",
      "score": <0-100>,
      "issues": ["<issue 1>"],
      "passed": ["<thing that is good>"]
    }
  ],
  "critical_issues": ["<issue 1>", "<issue 2>"],
  "recommendations": ["<actionable recommendation 1>", "<rec 2>"],
  "keyword_gaps": ["<missing keyword>"],
${rewriteField}
}

Categories to evaluate:
1. Formatting & Parsability (columns, tables, graphics, font issues)
2. Contact Information (completeness, placement)
3. Section Structure (standard headers, order)
4. Content Quality (action verbs, quantifiable achievements, bullet length)
5. Keywords & Skills${jobDescription?.trim() ? ' (keyword match vs job description)' : ' (general industry keywords)'}
6. Length & Density (appropriate length for experience level)
${rewriteInstruction}

Return ONLY the JSON object, no other text.`;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://ats-optimizer.pages.dev',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    }
  });
}
