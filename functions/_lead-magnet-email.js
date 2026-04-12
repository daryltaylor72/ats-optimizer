const DAY_MS = 24 * 60 * 60 * 1000;

export async function sendLeadMagnetStageEmail(apiKey, {
  stage,
  email,
  code,
  expiresAt,
  origin,
}) {
  const normalizedOrigin = origin.replace(/\/$/, '');
  const unlockUrl = `${normalizedOrigin}/tool/?unlock_code=${encodeURIComponent(code)}&restore=1`;
  const checklistUrl = `${normalizedOrigin}/free-checklist/ats-ready-checklist.html`;
  const expiryText = expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }) : null;

  const templates = {
    stage_1: {
      subject: 'Your ATS-Ready Checklist + free premium unlock',
      html: baseLayout({
        pretitle: 'ATScore',
        title: 'Your checklist and free unlock are ready',
        intro: 'Here is your ATS-Ready Resume Checklist and a one-time code to unlock one free premium report.',
        blocks: [
          buttonBlock('Download the Checklist', checklistUrl, '#22c55e'),
          noteBlock('Open the checklist in your browser, then save it as a PDF if you want a printable copy.'),
          codeBlock(code, expiryText),
          buttonBlock('Use My Free Unlock', unlockUrl, '#6c63ff'),
          paragraph('Use the unlock code on your results page to access the full premium report: complete issue list, keyword gaps, and fix-ready rewrite guidance.')
        ],
        footer: 'If you did not request this, you can safely ignore it.',
      }),
    },
    stage_2: {
      subject: '3 resume mistakes that get filtered out',
      html: baseLayout({
        pretitle: 'ATScore Tips',
        title: 'Three common reasons resumes get filtered out',
        intro: 'Most low-scoring resumes miss on the same few patterns:',
        blocks: [
          bulletBlock([
            'Missing role-specific keywords from the target job description',
            'Bullet points that describe duties instead of measurable impact',
            'Formatting that hides important experience from ATS parsers',
          ]),
          paragraph('Your free premium unlock is still active if you want to see exactly how those issues show up in your own resume.'),
          buttonBlock('Use My Free Unlock', unlockUrl, '#6c63ff'),
          expiryLine(expiryText),
        ],
      }),
    },
    stage_3: {
      subject: 'Try your resume against a real job description',
      html: baseLayout({
        pretitle: 'ATScore Tips',
        title: 'A better test: scan against a real job description',
        intro: 'A resume can look strong in general and still miss badly for a specific role.',
        blocks: [
          paragraph('The fastest way to improve your match rate is to paste the exact job description you want, rescan, and compare where the keywords and positioning drift.'),
          paragraph('Your free premium unlock still works if you want the full breakdown and rewrite guidance.'),
          buttonBlock('Open My Free Unlock', unlockUrl, '#6c63ff'),
          expiryLine(expiryText),
        ],
      }),
    },
    stage_4: {
      subject: 'Your free premium unlock expires tonight',
      html: baseLayout({
        pretitle: 'ATScore Reminder',
        title: 'Last call: your free premium unlock expires tonight',
        intro: 'This is your final reminder before the one-time unlock expires.',
        blocks: [
          codeBlock(code, expiryText),
          paragraph('If you want the full ATS breakdown, keyword gap analysis, and fix-ready rewrite guidance, use your code before it expires.'),
          buttonBlock('Unlock My Premium Report', unlockUrl, '#6c63ff'),
        ],
      }),
    },
    feedback: {
      subject: 'Quick question: was the premium report useful?',
      html: baseLayout({
        pretitle: 'ATScore Feedback',
        title: 'Was the premium report useful?',
        intro: 'If the report helped, reply with one sentence about what was most useful.',
        blocks: [
          paragraph('We read every response. The most helpful replies often become the next product improvements and future proof points on the site.'),
          buttonBlock('Reply to support@atscore.ai', 'mailto:support@atscore.ai?subject=ATScore%20feedback', '#6c63ff'),
        ],
      }),
    },
  };

  const template = templates[stage];
  if (!template) {
    throw new Error(`Unknown lead magnet email stage: ${stage}`);
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'ATScore <results@atscore.ai>',
      reply_to: ['support@atscore.ai'],
      to: [email],
      subject: template.subject,
      html: template.html,
    }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }
}

export function getLeadMagnetDueStage(claim, now = Date.now()) {
  const issuedAt = Date.parse(claim?.issued_at || '');
  if (!Number.isFinite(issuedAt)) return null;

  if (claim?.status === 'redeemed') {
    const redeemedAt = Date.parse(claim?.redeemed_at || '');
    if (Number.isFinite(redeemedAt) && now >= redeemedAt + DAY_MS && !claim.feedback_requested_at) {
      return 'feedback';
    }
    return null;
  }

  if (claim?.status !== 'issued') return null;
  if (claim?.expires_at && Date.parse(claim.expires_at) < now) return null;

  if (now >= issuedAt + 7 * DAY_MS && !claim.email_4_sent_at) return 'stage_4';
  if (now >= issuedAt + 5 * DAY_MS && !claim.email_3_sent_at) return 'stage_3';
  if (now >= issuedAt + 2 * DAY_MS && !claim.email_2_sent_at) return 'stage_2';
  return null;
}

function baseLayout({ pretitle, title, intro, blocks = [], footer = 'If you need help, just reply to this email.' }) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">
    <table role="presentation" style="margin-bottom:32px;border-collapse:collapse;">
      <tr>
        <td style="padding-right:8px;vertical-align:middle;">
          <div style="width:32px;height:32px;background:#6c63ff;border-radius:6px;line-height:32px;text-align:center;font-size:16px;color:#fff;">A</div>
        </td>
        <td style="vertical-align:middle;">
          <span style="color:#e8eaf0;font-size:16px;font-weight:600;">${escapeHtml(pretitle)}</span>
        </td>
      </tr>
    </table>

    <h1 style="color:#e8eaf0;font-size:24px;line-height:1.2;margin:0 0 10px;">${escapeHtml(title)}</h1>
    <p style="color:#9299b0;font-size:14px;line-height:1.7;margin:0 0 24px;">${escapeHtml(intro)}</p>

    ${blocks.join('\n')}

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;text-align:center;margin-top:28px;">
      <p style="color:#5a6080;font-size:12px;margin:0 0 6px;">ATScore · <a href="https://atscore.ai" style="color:#6c63ff;text-decoration:none;">atscore.ai</a> · <a href="mailto:support@atscore.ai" style="color:#6c63ff;text-decoration:none;">support@atscore.ai</a></p>
      <p style="color:#5a6080;font-size:11px;margin:0;">${escapeHtml(footer)}</p>
    </div>
  </div>
</body>
</html>`;
}

function paragraph(text) {
  return `<p style="color:#9299b0;font-size:13px;line-height:1.7;margin:0 0 18px;">${escapeHtml(text)}</p>`;
}

function noteBlock(text) {
  return `<p style="color:#5a6080;font-size:12px;line-height:1.6;margin:0 0 24px;text-align:center;">${escapeHtml(text)}</p>`;
}

function bulletBlock(items) {
  return `<ul style="margin:0 0 20px 18px;padding:0;color:#9299b0;font-size:13px;line-height:1.8;">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function buttonBlock(label, href, background) {
  return `<div style="text-align:center;margin:0 0 24px;"><a href="${escapeAttr(href)}" style="display:inline-block;background:${background};color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">${escapeHtml(label)}</a></div>`;
}

function codeBlock(code, expiryText) {
  return `
  <div style="background:#111318;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:24px;margin-bottom:24px;text-align:center;">
    <p style="color:#9299b0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 10px;">Your Premium Unlock Code</p>
    <div style="color:#e8eaf0;font-size:28px;font-weight:700;letter-spacing:2px;">${escapeHtml(code)}</div>
    ${expiryText ? `<p style="color:#5a6080;font-size:12px;margin:12px 0 0;">Expires ${escapeHtml(expiryText)}</p>` : ''}
  </div>`;
}

function expiryLine(expiryText) {
  if (!expiryText) return '';
  return `<p style="color:#5a6080;font-size:12px;line-height:1.6;margin:0 0 20px;">Your one-time unlock expires ${escapeHtml(expiryText)}.</p>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
