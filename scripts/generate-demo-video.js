#!/usr/bin/env node
/**
 * generate-demo-video.js — Generate a sample ATS coaching demo video
 * Uses ElevenLabs TTS + Hedra lip-sync pipeline
 *
 * Usage: node scripts/generate-demo-video.js
 * Polls until video is ready, then prints the URL.
 */

const HEDRA_BASE = 'https://api.hedra.com/web-app/public';
const HEDRA_CHARACTER_3 = 'd1dd37a3-e39a-4854-a298-6510289f9cf2';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const ELEVENLABS_VOICE_ID = 'pMsXgVXv3BLzUgSXRplE'; // Serena (same as production)
const ELEVENLABS_MODEL = 'eleven_turbo_v2';

// Keys from worksona-videos .env (same Hedra/ElevenLabs accounts)
const ELEVEN_KEY = process.env.ELEVEN_API_KEY;
const HEDRA_KEY = process.env.HEDRA_API_KEY;
const PORTRAIT_PATH = process.env.PORTRAIT_PATH || '../worksona-videos/ats_coach_portrait.png';

// Demo coaching script — mid-score candidate, general advice
const DEMO_SCRIPT = `Hi there! I just finished reviewing your resume, and I want to walk you through what I found.

First, the good news. You've got solid experience, and your career progression tells a clear story — that's something a lot of candidates miss. Your technical skills section is well-organized, and I can see you've quantified several of your achievements, which is exactly what hiring managers want to see.

Now, here's where we need to focus. Your resume scored a 58 on ATS compatibility, which means it's getting filtered out before a human ever reads it. The main issue? Your formatting. You're using a two-column layout with graphics that ATS software can't parse — it's literally scrambling your content. Second, you're missing critical keywords for the roles you're targeting. I found twelve high-value terms from typical job descriptions in your field that aren't anywhere on your resume.

Here's your next step: switch to a single-column, clean format and weave those missing keywords naturally into your experience bullets. That alone could push your score above 85. You've got the experience — we just need the ATS to actually see it.`;

const fs = require('fs');
const path = require('path');

async function main() {
  if (!ELEVEN_KEY || !HEDRA_KEY) {
    console.error('Missing API keys. Set ELEVEN_API_KEY and HEDRA_API_KEY env vars.');
    process.exit(1);
  }

  console.log('Step 1: Generating TTS audio via ElevenLabs...');
  const audioBuffer = await generateTTS(DEMO_SCRIPT);
  console.log(`  Audio generated: ${(audioBuffer.byteLength / 1024).toFixed(0)} KB`);

  console.log('Step 2: Uploading portrait to Hedra...');
  const portraitPath = path.resolve(__dirname, PORTRAIT_PATH);
  const portraitBuffer = fs.readFileSync(portraitPath);
  const portraitId = await hedraUploadAsset(portraitBuffer, 'image/png', 'coach-portrait.png', 'image');
  console.log(`  Portrait asset ID: ${portraitId}`);

  console.log('Step 3: Uploading audio to Hedra...');
  const audioId = await hedraUploadAsset(audioBuffer, 'audio/mpeg', 'demo-coaching.mp3', 'audio');
  console.log(`  Audio asset ID: ${audioId}`);

  console.log('Step 4: Starting Hedra lip-sync generation...');
  const jobId = await hedraStartJob(portraitId, audioId);
  console.log(`  Job ID: ${jobId}`);

  console.log('Step 5: Polling for completion...');
  let status = 'pending';
  let videoUrl = null;
  while (status !== 'complete' && status !== 'error') {
    await sleep(10000);
    const result = await hedraGetStatus(jobId);
    status = result.status;
    videoUrl = result.videoUrl;
    console.log(`  Status: ${status}`);
  }

  if (status === 'complete' && videoUrl) {
    console.log('\n✅ Demo video ready!');
    console.log(`Video URL: ${videoUrl}`);
    console.log('\nDownload with:');
    console.log(`  curl -o demo-coaching-video.mp4 "${videoUrl}"`);
  } else {
    console.error('\n❌ Video generation failed.');
    process.exit(1);
  }
}

async function generateTTS(text) {
  const url = `${ELEVENLABS_BASE}/text-to-speech/${ELEVENLABS_VOICE_ID}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`ElevenLabs error ${resp.status}: ${err.substring(0, 200)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function hedraUploadAsset(buffer, contentType, fileName, assetType) {
  // Step 1: Create asset record
  const createResp = await fetch(`${HEDRA_BASE}/assets`, {
    method: 'POST',
    headers: { 'X-API-Key': HEDRA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: fileName, type: assetType }),
  });
  if (!createResp.ok) throw new Error(`Hedra create error: ${await createResp.text()}`);
  const { id: assetId } = await createResp.json();

  // Step 2: Upload file
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: contentType }), fileName);
  const uploadResp = await fetch(`${HEDRA_BASE}/assets/${assetId}/upload`, {
    method: 'POST',
    headers: { 'X-API-Key': HEDRA_KEY },
    body: formData,
  });
  if (!uploadResp.ok) throw new Error(`Hedra upload error: ${await uploadResp.text()}`);
  return assetId;
}

async function hedraStartJob(portraitId, audioId) {
  const resp = await fetch(`${HEDRA_BASE}/generations`, {
    method: 'POST',
    headers: { 'X-API-Key': HEDRA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'video',
      ai_model_id: HEDRA_CHARACTER_3,
      start_keyframe_id: portraitId,
      audio_id: audioId,
      generated_video_inputs: {
        text_prompt: 'Natural speaking movement, professional career coaching, subtle hand gestures',
        ai_model_id: HEDRA_CHARACTER_3,
        resolution: '540p',
        aspect_ratio: '9:16',
      },
    }),
  });
  if (!resp.ok) throw new Error(`Hedra start error: ${await resp.text()}`);
  const { id } = await resp.json();
  return id;
}

async function hedraGetStatus(jobId) {
  const resp = await fetch(`${HEDRA_BASE}/generations/${jobId}/status`, {
    headers: { 'X-API-Key': HEDRA_KEY },
  });
  if (!resp.ok) throw new Error(`Hedra status error: ${await resp.text()}`);
  const data = await resp.json();
  const videoUrl = data.url || data.video_url
    || data.batch_results?.[0]?.url
    || data.batch_results?.[0]?.video_url
    || null;
  return { status: data.status, videoUrl };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error(e); process.exit(1); });
