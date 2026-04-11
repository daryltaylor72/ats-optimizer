#!/usr/bin/env node
/**
 * test-heygen.mjs — Generate a test HeyGen avatar video
 * Usage: node bin/test-heygen.mjs
 * Requires HEYGEN_API_KEY and HEYGEN_AVATAR_ID in .env
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => l.split('=').map((p, i) => i === 0 ? p.trim() : l.slice(l.indexOf('=') + 1).trim()))
);

const HEYGEN_API_KEY = env.HEYGEN_API_KEY;
const HEYGEN_AVATAR_ID = env.HEYGEN_AVATAR_ID;
const ELEVENLABS_API_KEY = env.ELEVENLABS_API_KEY;

if (!HEYGEN_API_KEY || !HEYGEN_AVATAR_ID) {
  console.error('Missing HEYGEN_API_KEY or HEYGEN_AVATAR_ID in .env');
  process.exit(1);
}

const TEST_SCRIPT = `Hi, I'm your AI career coach from AT Score. After reviewing thousands of resumes, I know exactly what it takes to get past ATS filters and land interviews at top companies. Upload your resume and in seconds I'll show you your score, pinpoint what's holding you back, and give you a fully rewritten version optimized to get through. Let's get your resume working as hard as you do.`;

async function uploadAudio(audioBuffer) {
  console.log('Uploading audio to HeyGen...');
  const res = await fetch('https://upload.heygen.com/v1/asset', {
    method: 'POST',
    headers: { 'X-API-KEY': HEYGEN_API_KEY, 'Content-Type': 'audio/mpeg' },
    body: audioBuffer,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log('Audio asset ID:', data.data.id);
  return data.data.id;
}

async function generateTTS() {
  if (!ELEVENLABS_API_KEY) {
    console.log('No ELEVENLABS_API_KEY — using HeyGen built-in voice for test');
    return null;
  }
  console.log('Generating TTS audio via ElevenLabs...');
  const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/pMsXgVXv3BLzUgSXRplE', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text: TEST_SCRIPT, model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs failed: ${res.status}`);
  return res.arrayBuffer();
}

async function startVideo(audioAssetId) {
  console.log('Starting HeyGen video generation...');
  const voiceConfig = audioAssetId
    ? { type: 'audio', audio_asset_id: audioAssetId }
    : { type: 'text', input_text: TEST_SCRIPT, voice_id: '8217ce4716a34615a75beec0685dbba8' };

  const res = await fetch('https://api.heygen.com/v2/video/generate', {
    method: 'POST',
    headers: { 'x-api-key': HEYGEN_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_inputs: [{
        character: { type: 'avatar', avatar_id: HEYGEN_AVATAR_ID, avatar_style: 'normal' },
        voice: voiceConfig,
        background: { type: 'image', url: 'https://images.unsplash.com/photo-1604328698692-f76ea9498e76?w=1280&h=720&fit=crop' },
      }],
      dimension: { width: 1280, height: 720 },
    }),
  });
  if (!res.ok) throw new Error(`Video start failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log('Video ID:', data.data.video_id);
  return data.data.video_id;
}

async function pollStatus(videoId) {
  console.log('Polling for completion...');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000)); // wait 10s between polls
    const res = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
      headers: { 'x-api-key': HEYGEN_API_KEY },
    });
    const data = await res.json();
    const { status, video_url } = data.data;
    console.log(`  [${i + 1}] status: ${status}`);
    if (status === 'completed') return video_url;
    if (status === 'failed') throw new Error('HeyGen video generation failed');
  }
  throw new Error('Timed out after 10 minutes');
}

(async () => {
  try {
    const audioBuffer = await generateTTS();
    const audioAssetId = audioBuffer ? await uploadAudio(audioBuffer) : null;
    const videoId = await startVideo(audioAssetId);
    const videoUrl = await pollStatus(videoId);
    console.log('\n✅ Video ready:', videoUrl);
  } catch (e) {
    console.error('\n❌ Error:', e.message);
    process.exit(1);
  }
})();
