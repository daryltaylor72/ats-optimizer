/**
 * _video-helpers.js — ElevenLabs TTS + HeyGen API helpers
 * Underscore prefix prevents this file from being treated as a route by Cloudflare Pages.
 *
 * Exports:
 *  - callElevenLabs()       : Generate TTS audio using ElevenLabs
 *  - heygenUploadAudio()    : Upload MP3 audio buffer to HeyGen asset storage
 *  - heygenStartJob()       : Start a HeyGen avatar video generation job
 *  - heygenGetStatus()      : Get current status of a HeyGen video generation job
 *
 * Used by:
 *  - video-review.js       : Kick off TTS + HeyGen job after script generation
 *  - video-status.js       : Poll HeyGen status and retrieve final video URL
 */

const HEYGEN_API_BASE    = 'https://api.heygen.com';
const HEYGEN_UPLOAD_BASE = 'https://upload.heygen.com';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const ELEVENLABS_VOICE_ID = 'pMsXgVXv3BLzUgSXRplE'; // Serena
const ELEVENLABS_MODEL = 'eleven_turbo_v2';

/**
 * Generate TTS audio using ElevenLabs.
 * @param {string} text  The script to speak aloud
 * @param {string} apiKey
 * @returns {Promise<ArrayBuffer>}  MP3 audio buffer
 * @throws {Error}  ElevenLabs error with status and response preview
 */
export async function callElevenLabs(text, apiKey) {
  const url = `${ELEVENLABS_BASE}/text-to-speech/${ELEVENLABS_VOICE_ID}`;
  const body = {
    text,
    model_id: ELEVENLABS_MODEL,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.8,
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`ElevenLabs request failed: ${e.message}`);
  }

  if (!response.ok) {
    let errPreview = '';
    try {
      const errText = await response.text();
      errPreview = errText.substring(0, 200);
    } catch {
      errPreview = '(unable to read error body)';
    }
    throw new Error(`ElevenLabs error ${response.status}: ${errPreview}`);
  }

  return response.arrayBuffer();
}

/**
 * Upload MP3 audio buffer to HeyGen asset storage.
 * @param {ArrayBuffer} buffer    Raw MP3 audio bytes
 * @param {string} apiKey
 * @returns {Promise<string>}     HeyGen asset ID
 * @throws {Error}
 */
export async function heygenUploadAudio(buffer, apiKey) {
  let response;
  try {
    response = await fetch(`${HEYGEN_UPLOAD_BASE}/v1/asset`, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'audio/mpeg',
      },
      body: buffer,
    });
  } catch (e) {
    throw new Error(`HeyGen upload request failed: ${e.message}`);
  }

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`HeyGen upload error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const assetId = data?.data?.id;
  if (!assetId) throw new Error('HeyGen upload succeeded but no asset ID returned');
  return assetId;
}

/**
 * Start a HeyGen avatar video generation job.
 * @param {string} avatarId   HeyGen avatar ID (from HEYGEN_AVATAR_ID secret)
 * @param {string} script     The coaching script text to speak
 * @param {string} voiceId    HeyGen voice ID (from HEYGEN_VOICE_ID secret)
 * @param {string} apiKey
 * @returns {Promise<string>} HeyGen video ID
 * @throws {Error}
 */
export async function heygenStartJob(avatarId, script, voiceId, apiKey) {
  const body = {
    video_inputs: [
      {
        character: {
          type: 'avatar',
          avatar_id: avatarId,
          avatar_style: 'normal',
        },
        voice: {
          type: 'text',
          input_text: script,
          voice_id: voiceId,
        },
        background: {
          type: 'image',
          url: 'https://images.unsplash.com/photo-1604328698692-f76ea9498e76?w=1280&h=720&fit=crop',
        },
      },
    ],
    dimension: { width: 1280, height: 720 },
  };

  let response;
  try {
    response = await fetch(`${HEYGEN_API_BASE}/v2/video/generate`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`HeyGen start job request failed: ${e.message}`);
  }

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`HeyGen start job error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const videoId = data?.data?.video_id;
  if (!videoId) throw new Error('HeyGen start job succeeded but no video ID returned');
  return videoId;
}

/**
 * Get the current status of a HeyGen video generation job.
 * @param {string} videoId
 * @param {string} apiKey
 * @returns {Promise<{status: string, videoUrl: string|null}>}
 *   status: 'completed' | 'failed' | 'pending' | 'processing'
 *   videoUrl: URL when status is 'completed', null otherwise
 * @throws {Error}
 */
export async function heygenGetStatus(videoId, apiKey) {
  let response;
  try {
    response = await fetch(`${HEYGEN_API_BASE}/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
      headers: { 'x-api-key': apiKey },
    });
  } catch (e) {
    throw new Error(`HeyGen status request failed: ${e.message}`);
  }

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`HeyGen status error ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const status   = data?.data?.status;
  const videoUrl = data?.data?.video_url || null;

  if (!status) throw new Error('HeyGen status response missing status field');
  return { status, videoUrl };
}
