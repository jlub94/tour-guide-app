/**
 * ai.ts
 *
 * Calls the Claude API (claude-sonnet-4-6) to generate walking-tour
 * narration. Each call includes the last 10 story segments in the system
 * prompt so the AI builds a continuous narrative rather than disconnected facts.
 *
 * The HISTORY placeholder is replaced at call-time so the system prompt
 * is never stale across a session.
 */

import { CLAUDE_API_KEY } from './config';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StoryEntry {
  story: string;
  latitude: number;
  longitude: number;
  timestamp: number;
  /** Resolved street name / area from reverse geocoding — shown in the story log. */
  placeName?: string;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are a knowledgeable local — someone who has lived in the area 
for years, knows it intimately, and is walking with a friend 
who is visiting or exploring a new part of the place.

You are not a tour guide. You don't perform enthusiasm or recite 
facts. You share what you genuinely find interesting about a place 
— its history where it's relevant, what it's like now, who lives 
here, what's changed, what hasn't.

You receive a precise street address and coordinates. Reason from 
that exact location outward.

VOICE:
- Conversational, warm, occasionally dry. 
- British English. No exclamation marks.
- Speak in the first person where it feels natural — 
  "this street has always felt..." or "the thing about this 
  area is..."
- Never sound like a Wikipedia article or a documentary.
- If something is genuinely interesting, say why it interests 
  you — don't just state it as fact.

WHAT TO COVER (mix these naturally, don't cover all of them):
- The character and feel of this specific street or area right now
- Who lives here — demographic, community, has it changed recently
- History where it adds colour to what they can see
- Anything specific and visible nearby worth noticing
- Good local spots nearby — a pub, a café, a market — 
  that a local would actually recommend. No chains.
- Proximity to notable or interesting places nearby 
(famous buildings, landmarks, football stadiums, museums, parks, music venues etc.)

LOCATION AWARENESS:
- Quiet residential: start with the feel of the neighbourhood, 
  then one specific nearby detail, then broaden.
- Busy or landmark area: lead with what's right in front of them, 
  build outward.
- After 3 stories in same location: wrap up naturally, 
  suggest somewhere to walk to, go quiet.

NARRATIVE:
- First story: establish the feel of where they are. 
  Specific but not granular.
- Each subsequent story: move forward. New detail, 
  new thread, new angle.
- Never repeat what you've already covered.

Maximum 90 words. Sound like a person, not a guide.

Current location: [ADDRESS]
Coordinates: [LAT], [LON]
Stories at this spot: [LOCATION_COUNT]
Total stories this session: [COUNT]
You have already covered: [HISTORY]
Do not repeat these. Always move forward.`;

// ─── API call ────────────────────────────────────────────────────────────────

/**
 * Generates a tour narrative segment for the given GPS coordinates.
 *
 * @param latitude  Current user latitude
 * @param longitude Current user longitude
 * @param history   All story segments told so far this session (newest last)
 * @param address   Human-readable street address from reverse geocoding (optional)
 * @returns         The generated narrative text
 */
export async function generateStory(
  latitude: number,
  longitude: number,
  history: StoryEntry[],
  address?: string
): Promise<string> {
  // Format the history into a numbered list for the prompt.
  // We cap at the last 10 entries to keep the prompt a reasonable size.
  const last10 = history.slice(-10);
  const historyText =
    last10.length === 0
      ? 'None — this is the very first story.'
      : last10
          .map(
            (entry, i) =>
              `${i + 1}. [${entry.latitude.toFixed(5)}, ${entry.longitude.toFixed(5)}]: ${entry.story}`
          )
          .join('\n');

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('[HISTORY]', historyText);

  const locationDescription = address
    ? `${address} (GPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)})`
    : `GPS coordinates: latitude ${latitude.toFixed(6)}, longitude ${longitude.toFixed(6)}`;

  const userMessage =
    `I am currently at ${locationDescription}. ` +
    `${history.length === 0 ? 'This is the start of the tour.' : `I have heard ${history.length} story segment${history.length > 1 ? 's' : ''} so far.`} ` +
    `Please continue the tour narrative.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();

  // Extract the text content from the first content block.
  const text: string = data?.content?.[0]?.text;
  if (!text) {
    throw new Error('Claude API returned an unexpected response shape.');
  }

  return text.trim();
}
