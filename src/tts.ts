/**
 * tts.ts
 *
 * Converts text to speech using the OpenAI TTS API (voice: onyx) and plays
 * it back via expo-audio (the modern replacement for expo-av).
 *
 * STREAMING NOTE:
 * True chunk-by-chunk audio streaming in React Native requires a native HTTP
 * streaming layer that is not available in plain Expo without ejecting. Instead
 * we use the fastest practical alternative:
 *   1. Fire the TTS request (network round-trip, typically < 1 s for 80 words).
 *   2. As soon as the complete response arrives, write it as a temporary MP3 file.
 *   3. Begin playback immediately — the user hears audio within ~1 second of the
 *      story being generated, which feels near-instant in practice.
 *
 * If you eject to bare workflow you can replace this with a native streaming
 * player (e.g. react-native-track-player) and pipe the ReadableStream directly.
 */

// AudioPlayer is only exported as a type from expo-audio; the constructor lives
// on AudioModule.AudioPlayer (the native module instance).
import type { AudioPlayer } from 'expo-audio';
import { AudioModule, setAudioModeAsync } from 'expo-audio';
// expo-file-system v19 moved cacheDirectory and EncodingType to a legacy subpath.
import * as FileSystem from 'expo-file-system/legacy';
import { OPENAI_API_KEY } from './config';

// ─── State ───────────────────────────────────────────────────────────────────

/** The currently active AudioPlayer, if any audio is playing/loaded. */
let currentPlayer: AudioPlayer | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Converts `text` to speech and plays it immediately.
 * If audio is already playing, it is stopped first.
 * Does nothing when `muted` is true.
 */
export async function speak(text: string, muted: boolean): Promise<void> {
  if (muted) return;

  // Configure the audio session so playback works when the silent switch is on
  // and continues in the background (requires UIBackgroundModes: audio in app.json).
  await setAudioModeAsync({
    playsInSilentMode: true,  // expo-audio uses playsInSilentMode (not playsInSilentModeIOS)
  });

  // Stop any in-progress narration before starting the next one.
  await stopSpeaking();

  // ── 1. Fetch TTS audio ────────────────────────────────────────────────────
  console.log('[tts] Fetching TTS audio for text of length:', text.length);
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: 'onyx',
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenAI TTS error ${response.status}: ${errBody}`);
  }

  // ── 2. Convert response to base64 and write temp file ────────────────────
  const audioBuffer = await response.arrayBuffer();
  const base64Audio = arrayBufferToBase64(audioBuffer);

  const tempPath = `${FileSystem.cacheDirectory}tts_${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(tempPath, base64Audio, {
    encoding: FileSystem.EncodingType.Base64,
  });
  console.log('[tts] Audio written to temp file, starting playback');

  // ── 3. Play immediately ───────────────────────────────────────────────────
  // Construct via AudioModule.AudioPlayer — the native class constructor.
  // Arguments: (source, updateIntervalMs, keepAudioSessionActive)
  const player = new AudioModule.AudioPlayer({ uri: tempPath }, 100, false);
  currentPlayer = player;
  player.play();

  // Clean up the temp file and release the player once playback finishes.
  player.addListener('playbackStatusUpdate', (status) => {
    if (status.didJustFinish) {
      FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
      player.remove();
      if (currentPlayer === player) currentPlayer = null;
      console.log('[tts] Playback finished, player released');
    }
  });
}

/**
 * Stops and unloads the current player immediately.
 * Call this first whenever the user explicitly stops playback (e.g. Stop Tour,
 * Mute), before any other teardown logic, to cut audio without delay.
 */
export async function stopAudio(): Promise<void> {
  if (currentPlayer) {
    try {
      currentPlayer.pause();
      currentPlayer.remove();
    } catch {
      // Player may already be released — safe to ignore.
    }
    currentPlayer = null;
  }
}

/**
 * Stops any currently playing narration immediately.
 * Alias of stopAudio — kept for internal use within this module.
 */
export async function stopSpeaking(): Promise<void> {
  return stopAudio();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts an ArrayBuffer to a base64 string for use with expo-file-system.
 * Uses a chunked approach to avoid call-stack overflow on large buffers.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
