/**
 * POST /recover
 * Body: { email }
 * Looks up token by email and sends a magic link recovery email.
 * Always returns 200 (don't reveal whether email exists).
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch { return json({ ok: true }); }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: true });

  const kv = env.TOKENS_KV;
  if (!kv || !env.RESEND_API_KEY) return json({ ok: true, _debug: !kv ? 'no_kv' : 'no_resend_key' });

  const token = await kv.get(`email:${email}`);
  if (!token) return json({ ok: true, _debug: 'email_not_found_in_kv' });

  // Verify token is still valid
  const raw = await kv.get(`token:${token}`);
  if (!raw) return json({ ok: true, _debug: 'token_not_found_in_kv' });

  const tokenData = JSON.parse(raw);
  if (new Date(tokenData.expires_at) < new Date()) return json({ ok: true, _debug: 'token_expired' });
  if (tokenData.scans_remaining <= 0 && tokenData.plan !== 'pro') return json({ ok: true, _debug: 'no_scans_remaining' });

  let emailError = null;
  try { await sendRecoveryEmail(env.RESEND_API_KEY, email, token, tokenData); }
  catch (e) { emailError = e.message; }

  return json({ ok: true, _debug: emailError || 'sent' });
}

async function sendRecoveryEmail(apiKey, to, token, tokenData) {
  const scansText = tokenData.scans_remaining >= 9000
    ? 'Unlimited scans'
    : `${tokenData.scans_remaining} scan${tokenData.scans_remaining !== 1 ? 's' : ''} remaining`;
  const planName = { single: 'Single Scan', starter: 'Starter Pack', pro: 'Pro' }[tokenData.plan] || tokenData.plan;

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

    <h1 style="color:#e8eaf0;font-size:22px;margin:0 0 8px;">Here's your access link</h1>
    <p style="color:#9299b0;font-size:14px;line-height:1.6;margin:0 0 32px;">Click the button below to restore your scans. This link works on any device.</p>

    <div style="background:#111318;border:1px solid rgba(108,99,255,0.3);border-radius:12px;padding:20px;margin-bottom:32px;">
      <p style="color:#9299b0;font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Your Plan</p>
      <p style="color:#e8eaf0;font-size:15px;font-weight:600;margin:0;">${planName} · ${scansText}</p>
    </div>

    <div style="text-align:center;margin-bottom:32px;">
      <a href="https://atscore.ai/tool?token=${token}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">
        Restore My Scans →
      </a>
      <p style="color:#5a6080;font-size:12px;margin-top:12px;">Bookmark this link to avoid needing to recover access again.</p>
    </div>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;text-align:center;">
      <p style="color:#5a6080;font-size:12px;margin:0 0 6px;">DeepTier Labs · <a href="https://atscore.ai" style="color:#6c63ff;text-decoration:none;">atscore.ai</a> · <a href="mailto:support@deeptierlabs.com" style="color:#6c63ff;text-decoration:none;">support@deeptierlabs.com</a></p>
      <p style="color:#5a6080;font-size:11px;margin:0;">If you didn't request this, you can safely ignore it.</p>
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
      subject: 'Your ATS Optimizer access link',
      html,
    }),
  });
  if (!r.ok) throw new Error(await r.text());
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
