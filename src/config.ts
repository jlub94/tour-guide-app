/**
 * config.ts
 *
 * Central place to read environment variables. Keys are injected at build time
 * by Expo from the .env file (EXPO_PUBLIC_ prefix). Do not import these keys
 * directly in UI components — always go through this module so it is easy to
 * swap in a backend-proxy implementation later.
 */

export const CLAUDE_API_KEY: string =
  process.env.EXPO_PUBLIC_CLAUDE_API_KEY ?? '';

export const OPENAI_API_KEY: string =
  process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? '';

if (!CLAUDE_API_KEY) {
  console.warn('[config] EXPO_PUBLIC_CLAUDE_API_KEY is not set. Check your .env file.');
}
if (!OPENAI_API_KEY) {
  console.warn('[config] EXPO_PUBLIC_OPENAI_API_KEY is not set. Check your .env file.');
}
