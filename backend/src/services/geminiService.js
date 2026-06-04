/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              GEMINI NATURAL LANGUAGE BRIDGE                  ║
 * ║   Converts free-text match descriptions → V9 matchData       ║
 * ╠══════════════════════════════════════════════════════════════║
 * ║  "Persija is playing now" → structured parameters → V9 tiers ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import axios from 'axios';
import { getLeagueGoalsAvg } from './agent47Service.js';
import { getNarrativePhaseModel } from '../../../shared/confidencePolicy.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ─── GROQ / OPENROUTER (free LLM — pick one, both are OpenAI-compatible) ─────
// Groq:       console.groq.com  → env var GROQ_API_KEY  — 14,400 req/day free
// OpenRouter: openrouter.ai     → env var GROQ_API_KEY  — many free models
//
// To use Groq:       GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
//                    GROQ_MODEL = 'llama-3.3-70b-versatile'
// To use OpenRouter: GROQ_URL = 'https://openrouter.ai/api/v1/chat/completions'
//                    GROQ_MODEL = 'meta-llama/llama-3.3-70b-instruct:free'
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = process.env.GROQ_URL     || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = process.env.GROQ_MODEL   || 'llama-3.3-70b-versatile';

// Fallback model chain — tried in order if the primary model returns a 404/400
const GROQ_FALLBACK_MODELS = [
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
  'mixtral-8x7b-32768',
];

const AVAILABLE = Boolean(GEMINI_API_KEY || GROQ_API_KEY);

if (!AVAILABLE) {
  console.warn('[LLM] Neither GEMINI_API_KEY nor GROQ_API_KEY set — natural language analysis disabled.');
} else {
  const providers = [GROQ_API_KEY && 'Groq', GEMINI_API_KEY && 'Gemini'].filter(Boolean);
  console.log(`[LLM] Active providers: ${providers.join(', ')}`);
}

// ─── Groq helper ──────────────────────────────────────────────────────────────
async function groqChat(systemPrompt, userText, { maxTokens = 2000, jsonMode = true } = {}) {
  if (!GROQ_API_KEY) return null;

  const modelsToTry = [GROQ_MODEL, ...GROQ_FALLBACK_MODELS.filter(m => m !== GROQ_MODEL)];

  for (const model of modelsToTry) {
    try {
      const response = await axios.post(GROQ_URL, {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userText },
        ],
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        temperature: 0.15,
        max_tokens: maxTokens,
      }, {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      const content = response.data?.choices?.[0]?.message?.content || null;
      if (content) {
        if (model !== GROQ_MODEL) console.log(`[Groq] Used fallback model: ${model}`);
        return content;
      }
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message || err.message;
      if (status === 404 || status === 400) {
        console.warn(`[Groq] Model ${model} unavailable (${status}): ${msg.slice(0, 80)} — trying next`);
        continue; // try next model
      }
      // Auth error, network error etc — don't retry
      console.warn(`[Groq] Request failed (${status ?? 'network'}): ${msg.slice(0, 120)}`);
      return null;
    }
  }

  console.warn('[Groq] All models failed — falling back to Gemini');
  return null;
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
// Tells Gemini exactly what structured JSON to produce for the V9 engine.
const SYSTEM_PROMPT = `You are a football analytics assistant for a sports betting analysis system called Agent 47 V9.

When given a free-text description of a football match (e.g. "Persija is playing now", "Arsenal vs Chelsea tonight in the Premier League"), you must:

1. Identify the match (home team, away team, league, competition stage)
2. Use your training knowledge to estimate realistic values for all V9 parameters
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
 * Convert a natural language match description into a structured V9 matchData object.
 * @param {string} userText — e.g. "Persija is playing now", "Arsenal vs Chelsea Premier League"
 * @returns {Promise<{matchData: object, geminiConfidence: number, geminiNotes: string}>}
 */
export async function naturalLanguageToMatchData(userText) {
  if (!AVAILABLE) {
    throw new Error('No LLM configured. Add GROQ_API_KEY or GEMINI_API_KEY to backend/.env.');
  }

  // Helper to parse and return the standard response shape
  function parseLLMText(rawText) {
    const cleaned = rawText.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.error) throw new Error(`LLM could not identify match: ${parsed.error}`);
    const { geminiConfidence = 50, geminiNotes = '' } = parsed;
    const matchData = { ...parsed };
    delete matchData.geminiConfidence;
    delete matchData.geminiNotes;
    return { matchData, geminiConfidence, geminiNotes };
  }

  // ── Try Groq first (free tier, fast) ────────────────────────────────────────
  if (GROQ_API_KEY) {
    try {
      const raw = await groqChat(SYSTEM_PROMPT, `Analyse this match: ${userText}`, { maxTokens: 1500 });
      if (raw) {
        const result = parseLLMText(raw);
        console.log('[Groq] naturalLanguageToMatchData: success');
        return result;
      }
    } catch (err) {
      console.warn('[Groq] naturalLanguageToMatchData failed:', err.message.slice(0, 120));
    }
  }

  // ── Fallback: Gemini ─────────────────────────────────────────────────────────
  if (!GEMINI_API_KEY) {
    throw new Error('GROQ_API_KEY failed and GEMINI_API_KEY not configured.');
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
      temperature: 0.2,
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

  try {
    return parseLLMText(rawText);
  } catch (err) {
    throw new Error(`Gemini response parse error: ${err.message}`);
  }
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
    console.warn('[Gemini Sports] Quota exhausted — returning empty live match list (no fabricated data shown to users)');
    return [];
  }
  console.log(`[Gemini Sports] Generated ${matches.length} live matches (AI-estimated)`);
  return matches;
}

// ─── CALIBRATE TODAY (SEARCH GROUNDING) ──────────────────────────────────────

const CALIBRATION_SYSTEM_PROMPT = `You are Agent 47, the global football analytics engine for SportyRabbi.

Using Google Search, find ALL real football matches SCHEDULED (not yet started) for today globally across all regulated professional leagues.
IMPORTANT: Only include matches with status "NS" (not started). Do NOT include live or finished matches.
Estimate V9 analytics parameters from your knowledge of team form, xG, squad, motivation, H2H etc.
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

// ─── ENRICHMENT CACHE ─────────────────────────────────────────────────────────
// Prevents re-burning Gemini quota on Railway restarts or frequent recalibrations.
// Cache keyed by "home|away" fixture pairs. Expires after 12 hours.
const enrichCache = new Map(); // key: "home|away" → { data, expiresAt }
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function getCached(home, away) {
  const key = `${home}|${away}`.toLowerCase();
  const entry = enrichCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { enrichCache.delete(key); return null; }
  return entry.data;
}

function setCache(home, away, data) {
  const key = `${home}|${away}`.toLowerCase();
  enrichCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── ENRICHMENT PROMPT ────────────────────────────────────────────────────────
function buildEnrichPrompt(batch, today) {
  return `Today is ${today}. The following football fixtures are CONFIRMED for today. Your task is to look up each team's real current-season data using Google Search and fill in the V9 analytics schema accurately.

For each fixture, search for:
- Current league standings (position, points, goal difference)
- Last 5-10 match results (W/D/L), goals scored and conceded
- Average xG and xGA this season
- Key squad absences (injuries/suspensions of important players)
- Head-to-head record in recent seasons
- Typical kick-off odds from major bookmakers

DO NOT change the team names, league, leagueId, country, or kickoffUTC — these are authoritative.
Set status "NS" for all. Return ONLY a valid JSON array.

Confirmed fixtures:
${JSON.stringify(batch, null, 2)}

Each element MUST use EXACTLY this schema:
{
  "match": { "home": "<exact>", "away": "<exact>", "league": "<exact>", "leagueId": <exact>, "country": "<exact>", "status": "NS", "minute": 0, "homeScore": 0, "awayScore": 0, "kickoffUTC": "<exact>" },
  "home": { "motivationScore": 7, "starPlayers": 3, "starPlayersMissing": 1, "recentForm": ["W","W","D","L","W"], "goalsScored": [2,1,2,1,3], "goalsConceded": [0,1,1,2,1], "xgAvg": 1.8, "xgaAvg": 1.1, "pace": 7, "leaguePosition": 3, "squadIntegrity": 90 },
  "away": { "motivationScore": 6, "starPlayers": 2, "starPlayersMissing": 0, "recentForm": ["W","D","W","L","D"], "goalsScored": [1,2,1,0,2], "goalsConceded": [1,1,0,2,1], "xgAvg": 1.4, "xgaAvg": 1.3, "pace": 6, "leaguePosition": 7, "squadIntegrity": 88 },
  "h2h": { "homeWins": 4, "awayWins": 3, "draws": 3, "avgGoals": 2.6, "bttsRate": 0.65 },
  "odds": { "homeWin": 2.1, "draw": 3.4, "awayWin": 3.8, "over25": 1.9, "btts": 1.8 },
  "context": { "neutralVenue": false, "earlyGoal": false, "redCard": false, "gameWeek": 35, "totalGameWeeks": 38, "homePoints": 55, "awayPoints": 42, "homeGoalDifferential": 20, "awayGoalDifferential": 5, "timezone": "Europe/London" }
}`;
}

/**
 * Given a confirmed fixture list from ESPN/API-Football, use Gemini with Google Search
 * grounding to fetch REAL current-season stats (positions, form, xG, H2H, injuries).
 *
 * - Processes in batches of 5 to avoid timeouts and stay within token limits
 * - Caches results for 12 hours so Railway restarts don't re-burn quota
 * - Each batch = 1 Gemini call. 88 fixtures = ~18 calls (vs 1500/day free tier)
 *
 * @param {Array<{home,away,league,leagueId,country,kickoffUTC}>} fixtureList
 * @returns {Promise<Array|null>}
 */
export async function enrichFixturesWithGemini(fixtureList) {
  if (!AVAILABLE) throw new Error('GEMINI_API_KEY not configured');
  if (!fixtureList || fixtureList.length === 0) return null;

  const today = new Date().toISOString().split('T')[0];
  const BATCH_SIZE = 5;
  const results = [];
  const uncached = [];

  // Pull anything already in cache
  for (const f of fixtureList) {
    const cached = getCached(f.home, f.away);
    if (cached) {
      results.push(cached);
    } else {
      uncached.push(f);
    }
  }
  if (uncached.length === 0) {
    console.log(`[Enrich] All ${fixtureList.length} fixtures served from cache`);
    return results;
  }
  console.log(`[Enrich] ${results.length} cached, ${uncached.length} need Gemini search enrichment (${Math.ceil(uncached.length / BATCH_SIZE)} batches)`);

  // Process uncached fixtures in batches of 5
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(uncached.length / BATCH_SIZE);

    let batchEnriched = null;

    for (const model of GEMINI_SPORTS_MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const body = {
          tools: [{ google_search: {} }],   // <-- Real-time search grounding
          systemInstruction: {
            parts: [{ text: 'You are a football analytics AI. Return only valid JSON arrays with no markdown and no extra text. Use Google Search to look up real current-season stats for each team.' }],
          },
          contents: [{ role: 'user', parts: [{ text: buildEnrichPrompt(batch, today) }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8000 },
        };
        const response = await axios.post(url, body, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000,
        });
        const parts = response.data?.candidates?.[0]?.content?.parts || [];
        const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
        if (!text.trim()) { console.warn(`[Enrich] batch ${batchNum} ${model} empty`); continue; }
        const start = text.indexOf('[');
        const end   = text.lastIndexOf(']');
        if (start === -1 || end === -1 || end <= start) { console.warn(`[Enrich] batch ${batchNum} ${model} no JSON array`); continue; }
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(parsed) || parsed.length === 0) { console.warn(`[Enrich] batch ${batchNum} ${model} empty array`); continue; }
        batchEnriched = parsed;
        console.log(`[Enrich] batch ${batchNum}/${totalBatches} via ${model} (search): ${parsed.length} fixtures`);
        break;
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.warn(`[Enrich] batch ${batchNum} ${model} failed: ${msg.slice(0, 120)}`);
      }
    }

    if (batchEnriched) {
      for (const enriched of batchEnriched) {
        const home = enriched.match?.home || '';
        const away = enriched.match?.away || '';
        setCache(home, away, enriched);
        results.push(enriched);
      }
    } else {
      // ── Gemini failed — try Groq (no search grounding but strong football knowledge) ──
      if (GROQ_API_KEY) {
        try {
          const enrichSysPrompt = 'You are a football analytics AI. Return only a valid JSON array with no markdown and no extra text. Use your training knowledge of football teams to provide realistic current-season stats for each fixture in the list.';
          const raw = await groqChat(enrichSysPrompt, buildEnrichPrompt(batch, today), { maxTokens: 8000, jsonMode: false });
          if (raw) {
            const start = raw.indexOf('[');
            const end   = raw.lastIndexOf(']');
            if (start !== -1 && end > start) {
              const parsed = JSON.parse(raw.slice(start, end + 1));
              if (Array.isArray(parsed) && parsed.length > 0) {
                batchEnriched = parsed;
                console.log(`[Enrich] batch ${batchNum}/${totalBatches} via Groq: ${parsed.length} fixtures`);
              }
            }
          }
        } catch (err) {
          console.warn(`[Enrich] batch ${batchNum} Groq failed:`, (err.response?.data?.error?.message || err.message).slice(0, 120));
        }
      }

      if (batchEnriched) {
        for (const enriched of batchEnriched) {
          const home = enriched.match?.home || '';
          const away = enriched.match?.away || '';
          setCache(home, away, enriched);
          results.push(enriched);
        }
      } else {
        // All providers failed for this batch — fixtures are skipped (no placeholders used)
        console.warn(`[Enrich] batch ${batchNum} all providers failed — using hash defaults for: ${batch.map(f => `${f.home} vs ${f.away}`).join(', ')}`);
      }
    }
  }

  if (results.length === 0) return null;
  console.log(`[Enrich] Total enriched: ${results.length}/${fixtureList.length} (${results.length - (fixtureList.length - uncached.length)} newly fetched, ${fixtureList.length - uncached.length} from cache)`);
  return results;
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
    console.warn('[Gemini Sports] Quota exhausted — returning empty upcoming match list (no fabricated data shown to users)');
    return [];
  }
  console.log(`[Gemini Sports] Generated ${matches.length} upcoming matches (AI-estimated)`);
  return matches;
}

// ─── CONTEXTUAL PARAMETER ADJUSTMENT (Gemini Search + Groq Reasoning) ────────
//
// Two-LLM pipeline that adds real analytical value BEFORE V9 runs:
//
//   Gemini+Search (ONE call per calibration cycle)
//     → Scans today's web for confirmed news: injuries, suspensions,
//       manager changes, lineup confirmations
//     → Structured facts, not narrative
//
//   Groq (one call per fixture WITH news, run in parallel)
//     → Receives the confirmed facts for that specific match
//     → Reasons about WHICH V9 input parameters to adjust and by HOW MUCH
//     → Bounded adjustments (±20 max, confirmed facts only, no guessing)
//
// Result: V9 runs on contextually-adjusted inputs — not just statistics.
// This is the genuine analytical value LLMs add that no API can provide.
// The narrative (generateMatchNarrative) remains unchanged after V9 runs.

const NEWS_FETCH_CACHE = new Map(); // key: YYYY-MM-DD → { data: Map, ts: number }

async function fetchTodayMatchNews(fixtureList) {
  if (!GEMINI_API_KEY || !fixtureList?.length) return new Map();
  const today = new Date().toISOString().split('T')[0];
  const cached = NEWS_FETCH_CACHE.get(today);
  if (cached && Date.now() - cached.ts < 2 * 60 * 60 * 1000) return cached.data; // 2h TTL

  const shortList = fixtureList.slice(0, 40)
    .map(f => `${f.home} vs ${f.away} (${f.league || 'Unknown'})`)
    .join('\n');

  const newsMap = new Map();
  for (const model of GEMINI_SPORTS_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await axios.post(url, {
        tools: [{ google_search: {} }],
        systemInstruction: { parts: [{ text: 'You are a football news analyst. Return ONLY valid JSON arrays. No markdown. No extra text outside the array brackets.' }] },
        contents: [{
          role: 'user',
          parts: [{ text: `Today is ${today}. Using Google Search, find CONFIRMED news from the last 72 hours about these football matches that would affect betting analysis:\n\n${shortList}\n\nOnly include verified facts: key player injuries/suspensions confirmed by a club or credible journalist, manager sackings in the last 7 days, confirmed lineup information from official sources. NEVER invent or speculate.\n\nFor each absent/suspended player, assess their ACTUAL recent contribution — not historical reputation. A holding midfielder who consistently disrupts play, wins possession, and covers ground is as impactful as a scorer. A goalkeeper in poor recent form may have less impact absent than their name suggests. Look for: goals/assists in last 10 games for attackers; clean sheets, saves-per-game for goalkeepers; tackles, interceptions, key passes for midfielders/defenders. Note if the team's results have clearly differed in recent matches without this specific player.\n\nReturn ONLY a valid JSON array ([] if no confirmed news found):\n[{"home":"...","away":"...","homeInjuries":[{"name":"...","position":"striker|midfielder|center-back|goalkeeper|winger|defensive-mid|fullback","role":"e.g. defensive-anchor|creative-hub|set-piece-taker|goalscorer|shot-stopper|ball-winner","recentImpact":"high|medium|low","recentContributionNotes":"brief factual note e.g. 2 goals in last 10 games or team kept 5 clean sheets in 6 with them or won 1 of 5 without them"}],"awayInjuries":[...],"homeManagerChange":false,"awayManagerChange":false,"notes":"any other confirmed context"}]\nOmit fixtures entirely if no confirmed news was found.` }],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4000 },
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });

      const parts = response.data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
      if (!text.trim()) continue;

      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start === -1 || end === -1 || end <= start) continue;

      const newsArray = JSON.parse(text.slice(start, end + 1));
      if (!Array.isArray(newsArray)) continue;

      for (const item of newsArray) {
        const key = `${(item.home || '').toLowerCase().trim()}:${(item.away || '').toLowerCase().trim()}`;
        if (key !== ':') newsMap.set(key, item);
      }
      console.log(`[ContextAdjust] Gemini+Search: confirmed news for ${newsMap.size} of ${fixtureList.length} fixtures`);
      break;
    } catch (err) {
      console.warn(`[ContextAdjust] News fetch ${model} failed: ${(err.response?.data?.error?.message || err.message).slice(0, 100)}`);
    }
  }

  NEWS_FETCH_CACHE.set(today, { data: newsMap, ts: Date.now() });
  return newsMap;
}

/**
 * fetchAndReasonContextAdjustments(fixtureList)
 *
 * Orchestrates the two-LLM parameter adjustment pipeline:
 *   1. Gemini+Search  — ONE call: get confirmed news for all fixtures
 *   2. Groq (parallel) — one call per fixture with news: reason about adjustments
 *
 * Returns Map<"home:away", { homeSquadIntegrity, awaySquadIntegrity,
 *   homeKeyAbsencesAdd, awayKeyAbsencesAdd, contextWarnings, adjustmentReasoning }>
 *
 * Fully graceful — returns empty Map on any failure. Never blocks calibration.
 */
export async function fetchAndReasonContextAdjustments(fixtureList) {
  if (!fixtureList?.length) return new Map();

  // Step 1: Gemini+Search — single call for all fixtures
  const newsMap = await fetchTodayMatchNews(fixtureList).catch(err => {
    console.warn('[ContextAdjust] News step skipped:', err.message);
    return new Map();
  });

  if (newsMap.size === 0) {
    console.log('[ContextAdjust] No confirmed news found — skipping parameter adjustments');
    return new Map();
  }

  // Step 2: Groq — parallel reasoning, only for fixtures with news
  const GROQ_SYS = `You are an Agent 47 V9 parameter adjustment specialist.
Given CONFIRMED news about a football match, decide if and how to adjust specific V9 input parameters before analysis runs.
RULES:
- Only adjust based on confirmed facts in the news. Never guess or infer.
- Numeric field changes: bounded at original value ±20, clamped 0-100.
- homeKeyAbsencesAdd / awayKeyAbsencesAdd: only add players CONFIRMED absent or suspended.
- Return null for any field you are NOT adjusting.
- If the news contains nothing that warrants a parameter change, return null/empty for all fields.
- Return ONLY valid JSON. No markdown. No explanation outside the JSON.

CRITICAL — Weight adjustments by ACTUAL recent contribution, not historical reputation:
- A high-profile player (e.g. star striker) with low recent form (e.g. 2 goals in last 10, team still winning) → small adjustment (3-6 points)
- A defensive midfielder who anchors the press, wins duels, and the team has lost 3 of 4 without them → large adjustment (12-18 points)
- A goalkeeper in recent poor form (errors leading to goals) who is now absent → their absence may be NEUTRAL or even slightly positive
- A set-piece specialist whose absence removes a major delivery threat → medium adjustment even if not a scorer
- Always read recentImpact and recentContributionNotes from the news data before deciding magnitude
- recentImpact=high → 10-18 point range, medium → 5-10, low → 0-5 (can return null if truly negligible)`;

  const tasks = [];
  for (const fixture of fixtureList) {
    const key = `${(fixture.home || '').toLowerCase().trim()}:${(fixture.away || '').toLowerCase().trim()}`;
    const news = newsMap.get(key);
    if (!news) continue;

    tasks.push((async () => {
      if (!GROQ_API_KEY) return [key, null];
      try {
        const userPrompt = `Match: ${fixture.home} vs ${fixture.away} (${fixture.league || ''})
Current V9 inputs:
  homeSquadIntegrity: ${fixture.homeSquadIntegrity ?? 85}
  awaySquadIntegrity: ${fixture.awaySquadIntegrity ?? 85}
  homeKeyAbsences: ${JSON.stringify(fixture.homeKeyAbsences || [])}
  awayKeyAbsences: ${JSON.stringify(fixture.awayKeyAbsences || [])}
Confirmed news: ${JSON.stringify(news)}

Return ONLY: {"homeSquadIntegrity":null,"awaySquadIntegrity":null,"homeKeyAbsencesAdd":[],"awayKeyAbsencesAdd":[],"contextWarnings":[],"adjustmentReasoning":""}`;

        const raw = await groqChat(GROQ_SYS, userPrompt, { maxTokens: 400, jsonMode: true });
        if (!raw) return [key, null];
        const parsed = JSON.parse(raw);
        if (parsed.adjustmentReasoning) {
          console.log(`[ContextAdjust] ${fixture.home} vs ${fixture.away}: ${parsed.adjustmentReasoning.slice(0, 100)}`);
        }
        return [key, parsed];
      } catch (err) {
        console.warn(`[ContextAdjust] Groq failed for ${fixture.home} vs ${fixture.away}: ${err.message.slice(0, 80)}`);
        return [key, null];
      }
    })());
  }

  const settled = await Promise.allSettled(tasks);
  const resultMap = new Map();
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) {
      const [key, adj] = r.value;
      if (adj) resultMap.set(key, adj);
    }
  }

  console.log(`[ContextAdjust] Groq reasoning complete: ${resultMap.size} fixtures adjusted`);
  return resultMap;
}

/**
 * generateMatchNarrative(analysis, matchInfo)
 * Calls Groq to produce a 2-3 sentence analyst note explaining the top V9 recommendation.
 * Returns { text, confidence } or null if Groq unavailable.
 *
 * This is the LLM layer that sits on top of V9's pure-math output.
 */
export async function generateMatchNarrative(analysis, matchInfo) {
  const { home = '?', away = '?', league = '', leagueId = 0, status = 'NS', matchMinutes = 0, score = '0-0',
    homeCards, awayCards } = matchInfo || {};
  const { overallScore = 0, recommendations = [], parameters = {}, poisson, winCall } = analysis || {};

  const topRec = recommendations[0];

  // Pull the 3 parameters with the highest individual scores to explain the decision
  const topParams = Object.entries(parameters)
    .map(([k, v]) => ({ name: k.replace(/p\d+_/, '').replace(/_/g, ' '), score: v?.score ?? 0, assessment: v?.assessment ?? '' }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const isLive = status === 'LIVE' || ['1H','2H','HT','ET','BT','P'].includes(status);
  const homeFormRaw = matchInfo?.homeForm || '';
  const awayFormRaw = matchInfo?.awayForm || '';
  const homeOpposition = matchInfo?.homeRecentOpposition || analysis?.dataContext?.homeRecentOpposition || null;
  const awayOpposition = matchInfo?.awayRecentOpposition || analysis?.dataContext?.awayRecentOpposition || null;
  const homePoss = matchInfo?.possession?.home ?? matchInfo?.homePossession ?? null;
  const awayPoss = matchInfo?.possession?.away ?? (homePoss != null ? 100 - homePoss : null);
  const homeShots = matchInfo?.shots?.home ?? null;
  const awayShots = matchInfo?.shots?.away ?? null;
  const homeXg = matchInfo?.xg?.home ?? null;
  const awayXg = matchInfo?.xg?.away ?? null;

  const formCompact = (s) => String(s || '')
    .toUpperCase()
    .split(/[-,\s]+/)
    .filter(Boolean)
    .slice(0, 5)
    .join('');

  const phaseModel = getNarrativePhaseModel(isLive ? 'LIVE' : 'NS', matchMinutes);

  const buildStructuredNarrative = (coreText = '') => {
    const baseline = isLive
      ? `${winCall?.selection || 'Wins (Undecided)'} at ${winCall?.confidence ?? overallScore}%, driven by ${topParams[0]?.name || 'the strongest V9 signal'} and ${topParams[1]?.name || 'supporting context'}.`
      : `${winCall?.selection || 'Wins (Undecided)'} at ${winCall?.confidence ?? overallScore}%, with form ${formCompact(homeFormRaw) || 'N/A'} vs ${formCompact(awayFormRaw) || 'N/A'} and opponent quality setting the baseline.`;

    const liveReality = isLive
      ? `Possession is ${homePoss ?? '-'}-${awayPoss ?? '-'}, shots are ${homeShots ?? '-'}-${awayShots ?? '-'}, xG is ${homeXg ?? '-'}-${awayXg ?? '-'}, and the score is ${score}.`
      : `Poisson projects ${poisson?.expectedTotalGoals ?? '--'} total goals, with likely score ${poisson?.likelyScore?.score || '--'} and draw probability ${poisson?.probabilities?.draw ?? '--'}%.`;

    const verdictCore = coreText
      ? coreText.replace(/\s+/g, ' ').trim()
      : (topRec?.logic || poisson?.assessment || `${winCall?.selection || 'Wins (Undecided)'} remains the current verdict.`);

    return [
      `Baseline: ${baseline}`,
      `Live reality: ${liveReality}`,
      `Verdict: ${verdictCore}`,
    ].join(' ');
  };

  const metricsBlock = [
    `PHASE MODEL: ${phaseModel.phase}. Baseline weight ${Math.round(phaseModel.baselineWeight * 100)}%, live weight ${Math.round(phaseModel.liveWeight * 100)}%.`,
    `LIVE METRICS: Possession ${home} ${homePoss ?? '-'}% vs ${away} ${awayPoss ?? '-'}%, Shots ${homeShots ?? '-'}-${awayShots ?? '-'}, xG ${homeXg ?? '-'}-${awayXg ?? '-'}, Score ${score}.`,
    `FORM (last 5): ${home} ${formCompact(homeFormRaw) || 'N/A'} | ${away} ${formCompact(awayFormRaw) || 'N/A'}.`,
    `OPPOSITION QUALITY: ${home} ${homeOpposition?.summary || 'recent opponent strength unavailable.'} ${away} ${awayOpposition?.summary || 'recent opponent strength unavailable.'}`,
    `WIN CALL: ${winCall?.selection || 'Wins (Undecided)'} (${winCall?.confidence ?? overallScore}%).`,
  ].join('\n');

  // ── Build rich live-context block for the LLM ──
  let liveContext = '';
  if (isLive) {
    const [hG, aG] = score.split('-').map(n => parseInt(n, 10) || 0);
    const scoreDiff = hG - aG;
    const minsLeft  = Math.max(90 - matchMinutes, 0);
    const leader    = scoreDiff > 0 ? home : scoreDiff < 0 ? away : null;
    const loser     = scoreDiff > 0 ? away : scoreDiff < 0 ? home : null;
    const hRed      = homeCards?.red || 0;
    const aRed      = awayCards?.red || 0;
    const hYel      = homeCards?.yellow || 0;
    const aYel      = awayCards?.yellow || 0;

    const scoreState = leader
      ? `${leader} leads ${hG}-${aG} (${Math.abs(scoreDiff)}-goal margin). ${loser} trailing — urgency to ${scoreDiff === 0 ? 'break deadlock' : 'equalize'}.`
      : `Goalless at ${matchMinutes}' — both teams pressing for opening goal.`;

    const cardState = (hRed > 0 || aRed > 0)
      ? `CARDS: ${hRed > 0 ? `${home} has ${hRed} red card (10 men). ` : ''}${aRed > 0 ? `${away} has ${aRed} red card (10 men). ` : ''}This dramatically changes goal expectation.`
      : (hYel + aYel >= 6 ? `Heavy yellow card count (${home}: ${hYel}, ${away}: ${aYel}) — physical, desperate play.` : '');

    const remainFrac = minsLeft / 90;
    const lH_rem = (poisson?.homeLambda || getLeagueGoalsAvg(leagueId)) * remainFrac;
    const lA_rem = (poisson?.awayLambda || getLeagueGoalsAvg(leagueId)) * remainFrac;
    const probGoal  = Math.round((1 - Math.exp(-(lH_rem + lA_rem))) * 100);

    liveContext = `LIVE SITUATION — ${matchMinutes}' played, ${minsLeft}' remaining.
Score: ${hG}-${aG}. ${scoreState}
${cardState}
Remaining expected goals: ${home} λ=${lH_rem.toFixed(2)}, ${away} λ=${lA_rem.toFixed(2)}. P(another goal): ${probGoal}%.
Top recommendation: ${topRec?.selection || 'None'} — ${topRec?.confidence || 0}% confidence.
Recommendation logic: ${topRec?.logic || ''}`;
  }

  const systemPrompt = `You are Agent 47, an elite football betting analyst.
Your job is to write a sharp, confident 2-3 sentence analyst note for a match.
${isLive ? 'FOCUS ON THE LIVE SITUATION: the score, who is winning, who is chasing, cards, and what the remaining expected goals data means for live bettors. Do NOT just echo the Poisson numbers — reason about the SITUATION.' : ''}
If the model says "Wins (Undecided)", say clearly that this is a tight game and winner is not certain yet.
Always include at least 3 concrete data points (e.g., possession, shots, xG, form, projected goals, opponent quality).
Use this phase rule: ${phaseModel.instruction}
Use this structure implicitly: 1) baseline expectation, 2) live reality, 3) verdict on whether live data confirms, weakens, or overturns the baseline.
Be direct. No caveats about gambling. No "I think" or "maybe". Speak as fact.
Return ONLY valid JSON: {"text": "<your 2-3 sentence note>", "confidence": <integer 0-100>}`;

  const userText = topRec
    ? `Match: ${home} vs ${away} (${league}).
${isLive ? liveContext : `Pre-match analysis. Overall V9 Score: ${overallScore}/100`}
${metricsBlock}
Key signal 1: ${topParams[0]?.name} [score ${topParams[0]?.score}] — ${(topParams[0]?.assessment || '').slice(0, 100)}
Key signal 2: ${topParams[1]?.name} [score ${topParams[1]?.score}] — ${(topParams[1]?.assessment || '').slice(0, 100)}
Key signal 3: ${topParams[2]?.name} [score ${topParams[2]?.score}] — ${(topParams[2]?.assessment || '').slice(0, 100)}
Write 2-3 sentences explaining the live betting opportunity and WHY the top recommendation makes sense given the situation.`
    : `Match: ${home} vs ${away} (${league}).
${isLive ? liveContext : `Pre-match. Overall V9 Score: ${overallScore}/100`}
${metricsBlock}
Key signal 1: ${topParams[0]?.name} [score ${topParams[0]?.score}] — ${(topParams[0]?.assessment || '').slice(0, 100)}
Key signal 2: ${topParams[1]?.name} [score ${topParams[1]?.score}] — ${(topParams[1]?.assessment || '').slice(0, 100)}
No strong directional edge. Write 2-3 sentences describing what the data shows.`;

  const raw = await groqChat(systemPrompt, userText, { maxTokens: 240, jsonMode: true });

  // Deterministic fallback when Groq is unavailable — build from V9 data directly
  if (!raw) {
    const fallback = buildStructuredNarrative(topRec?.logic || poisson?.assessment || 'The current data sets the edge.');
    return { text: fallback, confidence: topRec?.confidence || overallScore };
  }
  try {
    const parsed = JSON.parse(raw);
    return { text: buildStructuredNarrative(parsed.text || raw), confidence: parsed.confidence || topRec?.confidence || overallScore };
  } catch {
    return { text: buildStructuredNarrative(raw), confidence: topRec?.confidence || overallScore };
  }
}
