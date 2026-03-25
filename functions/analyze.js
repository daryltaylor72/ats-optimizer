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

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ detail: 'Invalid form data' }, 400);
  }

  const resumeFile = formData.get('resume');
  const jobDescription = formData.get('job_description') || '';

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
        { type: 'text', text: buildPrompt(null, jobDescription) }
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
      content: buildPrompt(resumeText, jobDescription)
    }];
  } else {
    return json({ detail: 'Unsupported file type. Please upload PDF or DOCX.' }, 400);
  }

  // Call Claude API
  let claudeResponse;
  try {
    claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages
      })
    });
  } catch (e) {
    return json({ detail: `API request failed: ${e.message}` }, 500);
  }

  if (!claudeResponse.ok) {
    const err = await claudeResponse.text();
    return json({ detail: `Claude API error: ${err}` }, 500);
  }

  const claudeData = await claudeResponse.json();
  const rawText = claudeData.content?.[0]?.text || '';

  // Strip markdown code fences
  const cleaned = rawText
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    return json({ detail: 'Failed to parse AI response as JSON' }, 500);
  }

  return json(result, 200);
}

function buildPrompt(resumeText, jobDescription) {
  const jdSection = jobDescription?.trim()
    ? `\n## Job Description to Match Against\n${jobDescription.trim()}\n`
    : '';

  const resumeSection = resumeText
    ? `\n## Resume Text\n${resumeText}\n`
    : '';

  const jobMatchNote = jobDescription?.trim()
    ? ', and optimize for the job description'
    : '';

  return `You are an expert ATS (Applicant Tracking System) resume optimizer. Analyze the resume${resumeText ? ' below' : ' in the attached document'} and provide a detailed ATS optimization report.
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
  "optimized_resume": "<full rewritten resume, plain text, ATS-optimized>"
}

Categories to evaluate:
1. Formatting & Parsability (columns, tables, graphics, font issues)
2. Contact Information (completeness, placement)
3. Section Structure (standard headers, order)
4. Content Quality (action verbs, quantifiable achievements, bullet length)
5. Keywords & Skills${jobDescription?.trim() ? ' (keyword match vs job description)' : ' (general industry keywords)'}
6. Length & Density (appropriate length for experience level)

For optimized_resume: rewrite the full resume in clean ATS-friendly plain text. Use standard section headers (CONTACT, SUMMARY, EXPERIENCE, EDUCATION, SKILLS). Keep all real experience but improve phrasing, add relevant keywords${jobMatchNote}. Format dates consistently. Use strong action verbs.

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
    headers: { 'Content-Type': 'application/json' }
  });
}
