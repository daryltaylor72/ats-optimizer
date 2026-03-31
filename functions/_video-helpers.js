/**
 * _video-helpers.js — ElevenLabs TTS + Hedra API helpers
 * Underscore prefix prevents this file from being treated as a route by Cloudflare Pages.
 *
 * Exports:
 *  - callElevenLabs()       : Generate TTS audio using ElevenLabs
 *  - hedraUploadAsset()     : Upload binary asset (audio or image) to Hedra
 *  - hedraStartJob()        : Start a Hedra lip-sync generation job
 *  - hedraGetStatus()       : Get current status of a Hedra generation job
 *
 * Used by:
 *  - video-review.js       : Kick off TTS + Hedra job after script generation
 *  - video-status.js       : Poll Hedra status and retrieve final video URL
 */

const HEDRA_BASE = 'https://mercury.dev.dream-ai.com/api';
const HEDRA_VEO3_FAST = '9963e814-d1ee-4518-a844-7ed380ddbb20';
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
 * Upload a binary asset (audio or image) to Hedra.
 * @param {ArrayBuffer} buffer
 * @param {string} contentType  e.g. 'audio/mpeg' or 'image/png'
 * @param {string} fileName     e.g. 'coaching.mp3'
 * @param {string} apiKey
 * @returns {Promise<string>}   Hedra asset ID
 * @throws {Error}  Hedra upload error with status and response preview
 */
export async function hedraUploadAsset(buffer, contentType, fileName, apiKey) {
  const url = `${HEDRA_BASE}/v1/assets`;
  const formData = new FormData();

  // Create a Blob from the buffer with the correct MIME type
  const blob = new Blob([buffer], { type: contentType });
  formData.append('file', blob, fileName);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
      },
      body: formData,
      // Note: FormData automatically sets Content-Type with boundary
    });
  } catch (e) {
    throw new Error(`Hedra upload request failed: ${e.message}`);
  }

  if (!response.ok) {
    let errPreview = '';
    try {
      const errText = await response.text();
      errPreview = errText.substring(0, 200);
    } catch {
      errPreview = '(unable to read error body)';
    }
    throw new Error(`Hedra upload error ${response.status}: ${errPreview}`);
  }

  const data = await response.json();
  if (!data.id) {
    throw new Error('Hedra upload succeeded but no asset ID returned');
  }

  return data.id;
}

/**
 * Start a Hedra lip-sync generation job.
 * @param {string} portraitAssetId  Pre-uploaded portrait asset ID
 * @param {string} audioAssetId     Freshly uploaded audio asset ID
 * @param {string} apiKey
 * @returns {Promise<string>}       Hedra job ID
 * @throws {Error}  Hedra start job error with status and response preview
 */
export async function hedraStartJob(portraitAssetId, audioAssetId, apiKey) {
  const url = `${HEDRA_BASE}/v1/characters`;
  const body = {
    model: HEDRA_VEO3_FAST,
    avatarImage: portraitAssetId,
    audioSource: audioAssetId,
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Hedra start job request failed: ${e.message}`);
  }

  if (!response.ok) {
    let errPreview = '';
    try {
      const errText = await response.text();
      errPreview = errText.substring(0, 200);
    } catch {
      errPreview = '(unable to read error body)';
    }
    throw new Error(`Hedra start job error ${response.status}: ${errPreview}`);
  }

  const data = await response.json();
  if (!data.jobId) {
    throw new Error('Hedra start job succeeded but no jobId returned');
  }

  return data.jobId;
}

/**
 * Get the current status of a Hedra generation job.
 * @param {string} hedraJobId
 * @param {string} apiKey
 * @returns {Promise<{status: string, videoUrl: string|null}>}
 * @throws {Error}  Hedra status error with status and response preview
 */
export async function hedraGetStatus(hedraJobId, apiKey) {
  const url = `${HEDRA_BASE}/v1/characters/${hedraJobId}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
      },
    });
  } catch (e) {
    throw new Error(`Hedra status request failed: ${e.message}`);
  }

  if (!response.ok) {
    let errPreview = '';
    try {
      const errText = await response.text();
      errPreview = errText.substring(0, 200);
    } catch {
      errPreview = '(unable to read error body)';
    }
    throw new Error(`Hedra status error ${response.status}: ${errPreview}`);
  }

  const data = await response.json();
  return {
    status: data.status,
    videoUrl: data.videoUrl || null,
  };
}
