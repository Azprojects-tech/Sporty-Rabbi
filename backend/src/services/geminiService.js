/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              GEMINI NATURAL LANGUAGE BRIDGE                  ║
 * ║   Converts free-text match descriptions → V6 matchData       ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  "Persija is playing now" → structured parameters → V6 tiers ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import axios from 'axios';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const AVAILABLE = Boolean(GEMINI_API_KEY);

if (!AVAILABLE) {
  console.warn('[Gemini] GEMINI_API_KEY not set — natural language analysis disabled.');
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
// Tells Gemini exactly what structured JSON to produce for the V6 engine.
const SYSTEM_PROMPT = `You are a football analytics assistant for a sports betting analysis system called Agent 47 V6 Frontier.

When given a free-text description of a football match (e.g. "Persija is playing now", "Arsenal vs Chelsea tonight in the Premier League"), you must:

1. Identify the match (home team, away team, league, competition stage)
2. Use your training knowledge to estimate realistic values for all V6 parameters
3. Return ONLY a valid JSON object — no markdown, no explanation, no extra text

The JSON must follow this exact shape:

{
  "match": {
    "home": "<home team name>",
    "away": "<away team name>",
    "league": "<league or competition name>",
    "stage": "<group/knockout/regular/final — use 'regular' if unsure>",
    "date": "<YYYY-MM-DD if known, else today's date>",
    "minute": <current match minute 0-90 if live, else 0>,
    "homeScore": <current score or 0>,
    "awayScore": <current score or 0>,
    "status": "<NS|LIVE|FT — NS if not started, LIVE if in progress>"
  },
  "home": {
    "motivationScore": <0-10, 10 = title decider / relegation battle>,
    "starPlayers": <number of world-class players available>,
    "starPlayersMissing": <number of world-class players missing (injury/suspension)>,
    "recentForm": [<last 5 results as W/D/L strings, newest first, e.g. ["W","W","D","L","W"]>],
    "goalsScored": [<goals scored in each of last 5 games, newest first>],
    "goalsConceded": [<goals conceded in each of last 5 games>],
    "xgAvg": <average xG per game last 5, e.g. 1.4>,
    "xgaAvg": <average xGA (expected goals against) per game last 5>,
    "pace": <team pace style 0-10, 10 = full press / high tempo>,
    "leaguePosition": <current league position integer>,
    "squadIntegrity": <0-100, percentage of first-choice squad available>
  },
  "away": {
    "motivationScore": <0-10>,
    "starPlayers": <integer>,
    "starPlayersMissing": <integer>,
    "recentForm": [<5 results W/D/L>],
    "goalsScored": [<5 numbers>],
    "goalsConceded": [<5 numbers>],
    "xgAvg": <number>,
    "xgaAvg": <number>,
    "pace": <0-10>,
    "leaguePosition": <integer>,
    "squadIntegrity": <0-100>
  },
  "h2h": {
    "homeWins": <last 10 meetings: how many home team won>,
    "awayWins": <last 10 meetings: how many away team won>,
    "draws": <last 10 meetings: draws>,
    "avgGoals": <average total goals in last 10 H2H meetings>,
    "bttsRate": <both teams scored rate in H2H, 0.0-1.0>
  },
  "odds": {
    "homeWin": <decimal odds for home win, e.g. 2.10>,
    "draw": <decimal odds for draw>,
    "awayWin": <decimal odds for away win>,
    "over25": <decimal odds for over 2.5 goals>,
    "btts": <decimal odds for both teams to score>
  },
  "context": {
    "neutralVenue": <true/false>,
    "earlyGoal": <true if a goal was scored before minute 20, else false>,
    "redCard": <true if any red card issued, else false>,
    "gameWeek": <integer, use 1 if unknown>,
    "totalGameWeeks": <total gameweeks in season, usually 34-38>,
    "homePoints": <home team current points, estimate if unsure>,
    "awayPoints": <away team current points, estimate if unsure>,
    "homeGoalDifferential": <home team goal difference, estimate>,
    "awayGoalDifferential": <away team goal difference, estimate>,
    "timezone": "<home team city timezone, e.g. Europe/London>"
  },
  "geminiConfidence": <0-100, how confident Gemini is in its estimates>,
  "geminiNotes": "<brief note about what Gemini knew vs estimated, max 2 sentences>"
}

Rules:
- Always produce valid JSON. Never include markdown code fences.
- Use your best knowledge for team form, xG, star players, league position.
- If you are unsure about a value, use a reasonable league-average estimate and lower geminiConfidence.
- For the current date (May 2026), use your knowledge of the 2025-26 season.
- If the user says "playing now" or "live", set status to "LIVE" and estimate the current minute.
- If you cannot identify the teams at all, return: {"error": "Could not identify match from description"}`;

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

/**
 * Convert a natural language match description into a structured V6 matchData object.
 * @param {string} userText — e.g. "Persija is playing now", "Arsenal vs Chelsea Premier League"
 * @returns {Promise<{matchData: object, geminiConfidence: number, geminiNotes: string}>}
 */
export async function naturalLanguageToMatchData(userText) {
  if (!AVAILABLE) {
    throw new Error('GEMINI_API_KEY not configured. Add it to backend/.env to enable natural language analysis.');
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: SYSTEM_PROMPT },
          { text: `\n\nAnalyse this match: ${userText}` },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,        // low temperature = more factual, less creative
      maxOutputTokens: 1500,
      responseMimeType: 'application/json',
    },
  };

  let rawText;
  try {
    const response = await axios.post(GEMINI_URL, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    // gemini-2.5-flash may return multiple parts (thinking + text); join them all
    const parts = response.data?.candidates?.[0]?.content?.parts || [];
    rawText = parts.map(p => p.text || '').join('');
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    throw new Error(`Gemini API error (${status ?? 'network'}): ${msg}`);
  }

  if (!rawText) {
    throw new Error('Gemini returned an empty response.');
  }

  // Parse — Gemini should return clean JSON but strip fences just in case
  const cleaned = rawText.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemini response was not valid JSON: ${cleaned.slice(0, 200)}`);
  }

  if (parsed.error) {
    throw new Error(`Gemini could not identify match: ${parsed.error}`);
  }

  const { geminiConfidence = 50, geminiNotes = '' } = parsed;

  // Return matchData without the Gemini-specific meta fields (V6 doesn't need them)
  const matchData = { ...parsed };
  delete matchData.geminiConfidence;
  delete matchData.geminiNotes;

  return { matchData, geminiConfidence, geminiNotes };
}

// ─── GEMINI SPORTS FEED (replaces API-Football when key is expired) ──────────
// Uses Gemini 2.5 Flash knowledge of the 2025-26 football season to generate
// realistic fixture data. Fast (~5s), no search grounding needed.

const GEMINI_SPORTS_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-2.0-flash',
];

/**
 * Ask Gemini (no search tool) for fixture data. Returns clean JSON via responseMimeType.
 * Tries multiple models in order if one is unavailable.
 */
async function geminiFetch(systemPrompt, userPrompt) {
  if (!AVAILABLE) return null; // triggers static fallback in callers
  for (const model of GEMINI_SPORTS_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await axios.post(
        url,
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 5000,
            responseMimeType: 'application/json',
          },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 45000 },
      );
      // gemini-2.5-flash may include thought parts; only use non-thought text
      const parts = response.data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
      if (!text.trim()) continue;
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : (parsed.matches || parsed.fixtures || []);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`[Gemini Sports] ${model} unavailable: ${msg.slice(0, 80)} — trying next model`);
    }
  }
  console.warn('[Gemini Sports] All models failed — using static fallback fixtures');
  return null; // caller should use static fallback
}

const SPORTS_SYSTEM_PROMPT = `You are a football data assistant for the SportyRabbi betting analytics platform.
You have detailed knowledge of the 2025-26 football season: fixture schedules, teams, leagues, European competitions.
Always return data in the exact JSON schema requested — no extra fields, no renamed fields.
leagueId values: Premier League=39, La Liga=140, Bundesliga=78, Ligue 1=61, Primeira Liga=64, Super Lig=203, Saudi Pro League=541, Champions League=1, Europa League=3, Conference League=849, World Cup=4, WC Qualifiers=18, EURO=2, Copa America=5, AFCON=6, Nations League=16, Olympics=17, Int Friendlies=15.
matchType values: League, Cup, Qualifier, Friendly.`;

// ─── STATIC FALLBACK FIXTURES ─────────────────────────────────────────────────
// Used when all Gemini models are quota-exhausted.
// These are realistic 2025-26 season end-of-year fixtures so the dashboard
// always has something to display.
const STATIC_UPCOMING_FIXTURES = [
  { id: 90001, home: 'Arsenal', away: 'Everton', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 68, opportunities: [], league: 'Premier League', leagueId: 39, matchType: 'League', leagueCountry: 'England' },
  { id: 90002, home: 'Manchester City', away: 'Wolverhampton', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 71, opportunities: [], league: 'Premier League', leagueId: 39, matchType: 'League', leagueCountry: 'England' },
  { id: 90003, home: 'Liverpool', away: 'Crystal Palace', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 74, opportunities: [], league: 'Premier League', leagueId: 39, matchType: 'League', leagueCountry: 'England' },
  { id: 90004, home: 'Chelsea', away: 'Nottm Forest', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 65, opportunities: [], league: 'Premier League', leagueId: 39, matchType: 'League', leagueCountry: 'England' },
  { id: 90005, home: 'Real Madrid', away: 'Villarreal', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 70, opportunities: [], league: 'La Liga', leagueId: 140, matchType: 'League', leagueCountry: 'Spain' },
  { id: 90006, home: 'Barcelona', away: 'Athletic Club', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 72, opportunities: [], league: 'La Liga', leagueId: 140, matchType: 'League', leagueCountry: 'Spain' },
  { id: 90007, home: 'Atletico Madrid', away: 'Getafe', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 66, opportunities: [], league: 'La Liga', leagueId: 140, matchType: 'League', leagueCountry: 'Spain' },
  { id: 90008, home: 'Bayern Munich', away: 'Hoffenheim', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 75, opportunities: [], league: 'Bundesliga', leagueId: 78, matchType: 'League', leagueCountry: 'Germany' },
  { id: 90009, home: 'Borussia Dortmund', away: 'Werder Bremen', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 67, opportunities: [], league: 'Bundesliga', leagueId: 78, matchType: 'League', leagueCountry: 'Germany' },
  { id: 90010, home: 'Bayer Leverkusen', away: 'RB Leipzig', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 69, opportunities: [], league: 'Bundesliga', leagueId: 78, matchType: 'League', leagueCountry: 'Germany' },
  { id: 90011, home: 'PSG', away: 'Lyon', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 73, opportunities: [], league: 'Ligue 1', leagueId: 61, matchType: 'League', leagueCountry: 'France' },
  { id: 90012, home: 'Marseille', away: 'Monaco', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 64, opportunities: [], league: 'Ligue 1', leagueId: 61, matchType: 'League', leagueCountry: 'France' },
  { id: 90013, home: 'Inter Milan', away: 'Lazio', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 70, opportunities: [], league: 'Europa League', leagueId: 3, matchType: 'Cup', leagueCountry: 'Europe' },
  { id: 90014, home: 'AC Milan', away: 'Fiorentina', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 65, opportunities: [], league: 'Conference League', leagueId: 849, matchType: 'Cup', leagueCountry: 'Europe' },
  { id: 90015, home: 'Juventus', away: 'Napoli', score: '0-0', possession: { home: 50, away: 50 }, shots: { home: 0, away: 0 }, xg: { home: 0.0, away: 0.0 }, status: 'NS', matchMinutes: 0, confidence: 72, opportunities: [], league: 'Champions League', leagueId: 1, matchType: 'Cup', leagueCountry: 'Europe' },
];

const STATIC_LIVE_FIXTURES = [
  { id: 80001, home: 'Tottenham', away: 'Aston Villa', score: '1-0', possession: { home: 54, away: 46 }, shots: { home: 8, away: 5 }, xg: { home: 1.3, away: 0.7 }, status: 'LIVE', matchMinutes: 62, confidence: 70, opportunities: [], league: 'Premier League', leagueId: 39, matchType: 'League', leagueCountry: 'England' },
  { id: 80002, home: 'Sevilla', away: 'Valencia', score: '0-0', possession: { home: 51, away: 49 }, shots: { home: 4, away: 6 }, xg: { home: 0.6, away: 0.9 }, status: 'LIVE', matchMinutes: 38, confidence: 61, opportunities: [], league: 'La Liga', leagueId: 140, matchType: 'League', leagueCountry: 'Spain' },
];

/**
 * Use Gemini knowledge to generate LIVE match data.
 * Returns an array already in the app's internal sanitizeMatch-compatible format.
 * NOTE: Live data is estimated; for truly real-time scores renew the API-Football subscription.
 */
export async function fetchLiveMatchesViaGemini() {
  const now = new Date();
  const dayOfWeek = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const dateStr = now.toISOString().split('T')[0];
  const hourUTC = now.getUTCHours();

  const prompt = `Today is ${dateStr} (${dayOfWeek}), current UTC hour is ${hourUTC}:00.
Based on the 2025-26 football season schedule, generate 0-8 matches that would realistically be LIVE (in-progress) right now.
Consider typical kick-off times (15:00, 17:30, 19:45, 20:00, 20:45 CET). Only include matches from the whitelisted leagues.
Return a JSON array (may be empty []) where each object has EXACTLY these fields:
{"id":10001,"home":"Team A","away":"Team B","score":"1-0","possession":{"home":58,"away":42},"shots":{"home":7,"away":3},"xg":{"home":1.2,"away":0.6},"status":"LIVE","matchMinutes":67,"confidence":72,"opportunities":[],"league":"Premier League","leagueId":39,"matchType":"League","leagueCountry":"England"}`;

  const matches = await geminiFetch(SPORTS_SYSTEM_PROMPT, prompt);
  if (matches === null) {
    console.log('[Gemini Sports] Using static live fallback (quota exhausted)');
    return STATIC_LIVE_FIXTURES;
  }
  console.log(`[Gemini Sports] Generated ${matches.length} live matches (AI-estimated)`);
  return matches;
}

// ─── CALIBRATE TODAY (SEARCH GROUNDING) ──────────────────────────────────────

const CALIBRATION_SYSTEM_PROMPT = `You are Agent 47, the global football analytics engine for SportyRabbi.

Using Google Search, find ALL real football matches SCHEDULED (not yet started) for today globally across all regulated professional leagues.
IMPORTANT: Only include matches with status "NS" (not started). Do NOT include live or finished matches.
Estimate V8 analytics parameters from your knowledge of team form, xG, squad, motivation, H2H etc.
Return ONLY a valid JSON array — no markdown, no explanation, nothing else outside the array brackets.

Each element MUST follow EXACTLY this schema (no extra fields, no renamed fields):
{
  "match": { "home": "Team Name", "away": "Team Name", "league": "League Name", "leagueId": 39, "country": "England", "status": "NS", "minute": 0, "homeScore": 0, "awayScore": 0, "kickoffUTC": "2026-05-07T19:45:00Z" },
  "home": { "motivationScore": 7, "starPlayers": 3, "starPlayersMissing": 1, "recentForm": ["W","W","D","L","W"], "goalsScored": [2,1,2,1,3], "goalsConceded": [0,1,1,2,1], "xgAvg": 1.8, "xgaAvg": 1.1, "pace": 7, "leaguePosition": 3, "squadIntegrity": 90 },
  "away": { "motivationScore": 6, "starPlayers": 2, "starPlayersMissing": 0, "recentForm": ["W","D","W","L","D"], "goalsScored": [1,2,1,0,2], "goalsConceded": [1,1,0,2,1], "xgAvg": 1.4, "xgaAvg": 1.3, "pace": 6, "leaguePosition": 7, "squadIntegrity": 88 },
  "h2h": { "homeWins": 4, "awayWins": 3, "draws": 3, "avgGoals": 2.6, "bttsRate": 0.65 },
  "odds": { "homeWin": 2.1, "draw": 3.4, "awayWin": 3.8, "over25": 1.9, "btts": 1.8 },
  "context": { "neutralVenue": false, "earlyGoal": false, "redCard": false, "gameWeek": 35, "totalGameWeeks": 38, "homePoints": 55, "awayPoints": 42, "homeGoalDifferential": 20, "awayGoalDifferential": 5, "timezone": "Europe/London" }
}

leagueId reference: Premier League=39, La Liga=140, Bundesliga=78, Serie A=135, Ligue 1=61, Eredivisie=88, Primeira Liga=64, Super Lig=203, Saudi Pro=541, Champions League=1, Europa League=3, Conference League=849, World Cup=4, WC Qualifiers=18, EURO=2, Copa America=5, AFCON=6, Nations League=16, Olympics=17, Int Friendlies=15, J-League=98, K-League=292, A-League=188, MLS=253, Brazilian Serie A=71, Argentine Liga=128, Colombian Primera=239, Greek Super League=197, Polish Ekstraklasa=106, Scottish Premiership=179, Belgian Pro League=144, Russian Premier=235.

Include ALL global regulated professional leagues. Target 10-60 matches. Do NOT include amateur or youth competitions. Do NOT invent matches — only include matches you can confirm exist today via search.`;

/**
 * Calibrate today's global football schedule using Gemini with Google Search grounding.
 * Returns array of V6-compatible fixture objects, or null if all models fail.
 * @returns {Promise<Array|null>}
 */
export async function calibrateDay() {
  if (!AVAILABLE) throw new Error('GEMINI_API_KEY not configured');

  const today = new Date().toISOString().split('T')[0];

  for (const model of GEMINI_SPORTS_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const body = {
        tools: [{ google_search: {} }],
        systemInstruction: { parts: [{ text: CALIBRATION_SYSTEM_PROMPT }] },
        contents: [{
          role: 'user',
          parts: [{ text: `Today is ${today}. Use Google Search to find all football matches scheduled globally today and return them as a JSON array per your instructions schema.` }],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 16000,
        },
      };

      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 90000,
      });

      const parts = response.data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');

      if (!text.trim()) {
        console.warn(`[Calibrate] ${model} returned empty text`);
        continue;
      }

      // Find JSON array bounds in response (may have surrounding explanation)
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start === -1 || end === -1 || end <= start) {
        console.warn(`[Calibrate] ${model} no JSON array found in response`);
        continue;
      }

      const fixtures = JSON.parse(text.slice(start, end + 1));
      if (!Array.isArray(fixtures) || fixtures.length === 0) {
        console.warn(`[Calibrate] ${model} returned empty array`);
        continue;
      }

      console.log(`[Calibrate] ${model}: ${fixtures.length} global fixtures via search grounding`);
      return fixtures;
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn(`[Calibrate] ${model} failed: ${msg.slice(0, 100)}`);
    }
  }

  console.warn('[Calibrate] All models failed — falling back to static fixtures');
  return null;
}

/**
 * Use Gemini knowledge to generate upcoming match fixtures (next 24 hours).
 * Returns an array already in the app's internal sanitizeMatch-compatible format.
 */
export async function fetchUpcomingMatchesViaGemini() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const prompt = `Today is ${dateStr}, tomorrow is ${tomorrow}.
Based on the 2025-26 football season schedule, generate 10-25 matches scheduled to kick off in the next 24 hours.
Include matches from Premier League, La Liga, Bundesliga, Ligue 1, Champions League, Europa League, Conference League, and other whitelisted competitions if matches are scheduled.
Return a JSON array where each object has EXACTLY these fields:
{"id":20001,"home":"Team A","away":"Team B","score":"0-0","possession":{"home":50,"away":50},"shots":{"home":0,"away":0},"xg":{"home":0.0,"away":0.0},"status":"NS","matchMinutes":0,"confidence":60,"opportunities":[],"league":"Premier League","leagueId":39,"matchType":"League","leagueCountry":"England"}`;

  const matches = await geminiFetch(SPORTS_SYSTEM_PROMPT, prompt);
  if (matches === null) {
    console.log('[Gemini Sports] Using static upcoming fallback (quota exhausted)');
    return STATIC_UPCOMING_FIXTURES;
  }
  console.log(`[Gemini Sports] Generated ${matches.length} upcoming matches (AI-estimated)`);
  return matches;
}
