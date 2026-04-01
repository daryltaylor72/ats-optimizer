/**
 * Cloudflare Pages Function — POST /chat
 * AI chatbot for ResumeATS — answers questions about the product.
 * Body: { message: string, history: [{role, content}] }
 * Returns: { reply: string }
 */

const SYSTEM_PROMPT = `You are the ResumeATS AI assistant — a friendly, knowledgeable career tool advisor for ats.deeptierlabs.com. Your job is to help job seekers understand the product and decide if it's right for them.

About ResumeATS:
- Free ATS resume checker: upload a PDF or DOCX resume and get an ATS score (0-100), category breakdown (formatting, keywords, contact info, content quality, readability), and specific recommendations. Free scans are available, no sign-up needed.
- Single Scan ($12): 1 credit — use for ATS scanner, cover letter generator, or interview prep Q&A. Token emailed after purchase.
- Starter Pack ($49): 5 credits ($9.80 each) — best value for active job seekers applying to multiple roles. Mix and match across tools.
- Video + Scan Bundle ($20): 1 ATS scan + AI resume rewrite + a personalized 60-90 second AI coaching video emailed to you in ~5 minutes. Powered by ElevenLabs + Hedra lip-sync AI.
- Pro ($49/mo): Unlimited credits for all tools — ATS scanner, cover letter, interview prep. Cancel anytime.
- All plans come with a 7-day satisfaction guarantee.

Key facts:
- Supports PDF and DOCX up to 10MB
- Free scan results in ~30 seconds, no sign-up needed
- The AI rewrite preserves your real experience — no fabrication
- Resume data is not stored after analysis
- Token recovery: visit /tool#recover or check your purchase confirmation email
- Pro cancellations: email support@deeptierlabs.com
- Video coaching (in the Bundle) takes ~3-5 minutes to generate; link is emailed automatically

Rules:
- Use short paragraphs separated by blank lines (\\n\\n) — never write a wall of text.
- Each distinct point or step should be its own paragraph.
- Be concise and helpful. If listing options, put each on its own line.
- If someone asks to scan their resume, direct them to /tool
- If someone asks about pricing, explain the options clearly
- If someone seems ready to buy, encourage them with the relevant CTA
- Never make up features that don't exist
- If you're unsure, say "I'm not sure — email support@deeptierlabs.com for help"`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'Not configured' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { message, history = [] } = body;
  if (!message || typeof message !== 'string' || message.length > 500) {
    return json({ error: 'Invalid message' }, 400);
  }

  // Build messages array — keep last 10 turns max
  const trimmed = history.slice(-10);
  const messages = [
    ...trimmed,
    { role: 'user', content: message.trim() },
  ];

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!resp.ok) {
    return json({ error: 'AI unavailable' }, 502);
  }

  const data = await resp.json();
  const reply = data.content?.[0]?.text || 'Sorry, I had trouble responding. Try again!';
  return json({ reply });
}
