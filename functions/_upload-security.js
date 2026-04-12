export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function validateMultipartSize(request) {
  const contentLength = Number.parseInt(request.headers.get('content-length') || '', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return json({ detail: 'File too large (max 10MB)' }, 400);
  }
  return null;
}

export async function applyRateLimit(kv, request, keyPrefix, limit, windowSeconds, message) {
  if (!kv) return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const rateKey = `ratelimit:${keyPrefix}:${ip}:${bucket}`;
  const count = Number.parseInt((await kv.get(rateKey)) || '0', 10);
  if (count >= limit) {
    return json({ detail: message }, 429);
  }
  await kv.put(rateKey, String(count + 1), { expirationTtl: windowSeconds });
  return null;
}

export function validateResumeUpload(file, bytes) {
  if (!file || typeof file === 'string') {
    return { ok: false, response: json({ detail: 'No resume file uploaded' }, 400) };
  }

  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ok: false, response: json({ detail: 'File too large (max 10MB)' }, 400) };
  }

  const filename = file.name || 'resume';
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';

  if (ext === 'doc') {
    return {
      ok: false,
      response: json({ detail: 'Legacy .doc files are no longer supported. Please upload a PDF or DOCX file.' }, 400),
    };
  }

  if (ext === 'pdf') {
    if (!isPdfFile(bytes)) {
      return { ok: false, response: json({ detail: 'Invalid PDF file. Please upload a valid, uncorrupted PDF.' }, 400) };
    }
    return { ok: true, type: 'pdf' };
  }

  if (ext === 'docx') {
    if (!isDocxFile(bytes)) {
      return { ok: false, response: json({ detail: 'Invalid DOCX file. Please upload a valid Microsoft Word .docx file.' }, 400) };
    }
    return { ok: true, type: 'docx' };
  }

  return { ok: false, response: json({ detail: 'Unsupported file type. Please upload PDF or DOCX.' }, 400) };
}

export function sanitizePlainText(value, maxLength = 600) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeStringArray(values, maxItems = 8, maxItemLength = 220) {
  if (!Array.isArray(values)) return [];
  return values
    .map(value => sanitizePlainText(value, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function sanitizeAnalysisResult(result) {
  const score = clampNumber(result?.score, 0, 100);
  const categories = Array.isArray(result?.categories)
    ? result.categories
        .map(category => ({
          name: sanitizePlainText(category?.name, 80),
          score: clampNumber(category?.score, 0, 100),
        }))
        .filter(category => category.name)
        .slice(0, 8)
    : [];

  return {
    score,
    grade: sanitizePlainText(result?.grade, 4),
    summary: sanitizePlainText(result?.summary, 500),
    categories,
    critical_issues: sanitizeStringArray(result?.critical_issues, 10, 220),
    recommendations: sanitizeStringArray(result?.recommendations, 10, 220),
    keyword_gaps: sanitizeStringArray(result?.keyword_gaps, 20, 60),
    optimized_resume: sanitizePlainText(result?.optimized_resume, 20000),
  };
}

export function sanitizeVideoReviewResult(result) {
  return {
    script: sanitizePlainText(result?.script, 2500),
    name_extracted: sanitizePlainText(result?.name_extracted, 80),
    duration_estimate_seconds: clampNumber(result?.duration_estimate_seconds, 0, 600),
    key_strengths: sanitizeStringArray(result?.key_strengths, 5, 180),
    improvements: sanitizeStringArray(result?.improvements, 5, 180),
    next_step: sanitizePlainText(result?.next_step, 200),
  };
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function isPdfFile(bytes) {
  const header = new Uint8Array(bytes.slice(0, 5));
  return header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46 && header[4] === 0x2d;
}

function isDocxFile(bytes) {
  const header = new Uint8Array(bytes.slice(0, 4));
  const isZip = header[0] === 0x50 && header[1] === 0x4b && (header[2] === 0x03 || header[2] === 0x05 || header[2] === 0x07);
  if (!isZip) return false;
  const sample = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(bytes.byteLength, 128 * 1024)));
  return sample.includes('[Content_Types].xml') && sample.includes('word/document.xml');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
