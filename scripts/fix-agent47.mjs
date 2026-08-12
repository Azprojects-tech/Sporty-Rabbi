/**
 * Patches agent47Service.js:
 * 1. Remove numeric defaults for standings/squad params (use null)
 * 2. scoreMotivation returns null-score when positions are missing
 * 3. scoreStarPower returns null-score when integrity is null
 * 4. scorePace returns null-score when shots/conversion are null
 */

import { readFileSync, writeFileSync } from 'fs';

let src = readFileSync('backend/src/services/agent47Service.js', 'utf8');

// ─── 1. analyzeV9 destructuring defaults ─────────────────────────────────────
src = src.replace(
  /homePosition = 10, awayPosition = 10, homePoints = 40, awayPoints = 40,\s*\n\s*status = 'NS'/,
  "homePosition = null, awayPosition = null, homePoints = null, awayPoints = null,\n    status = 'NS'"
);
console.log('1a. null position/points defaults');

src = src.replace(
  /totalTeams = 20, gameWeek = 30, totalGW = 38,/,
  "totalTeams = null, gameWeek = null, totalGW = null,"
);
console.log('1b. null totalTeams/gameWeek defaults');

src = src.replace(
  /homeSquadIntegrity = 90, awaySquadIntegrity = 90,/,
  "homeSquadIntegrity = null, awaySquadIntegrity = null,"
);
console.log('1c. null squad integrity defaults');

src = src.replace(
  /homePossession = 50,/,
  "homePossession = null,"
);
console.log('1d. null possession default');

src = src.replace(
  /homeShotsPerGame = 12, awayShotsPerGame = 10,/,
  "homeShotsPerGame = null, awayShotsPerGame = null,"
);
console.log('1e. null shots defaults');

src = src.replace(
  /homeConversionPct = 10, awayConversionPct = 10,/,
  "homeConversionPct = null, awayConversionPct = null,"
);
console.log('1f. null conversion defaults');

// ─── 2. scoreMotivation: null guard ──────────────────────────────────────────
const oldScoreMotivation = `function scoreMotivation({ homePosition, awayPosition, homePoints, awayPoints, totalTeams = 20, gameWeek, totalGW = 38 }) {
  const lifecycle = gameWeek / totalGW;
  const late = lifecycle > 0.75;`;

const newScoreMotivation = `function scoreMotivation({ homePosition, awayPosition, homePoints, awayPoints, totalTeams = 20, gameWeek, totalGW = 38 }) {
  if (homePosition == null || awayPosition == null) {
    return {
      score: null, available: false, evidenceStatus: 'MISSING',
      home: { motivation: null, situation: 'unknown' }, away: { motivation: null, situation: 'unknown' },
      gap: null, edge: 'NEUTRAL', mwvIndex: 0,
      assessment: 'Required inputs unavailable \u2014 league positions missing.',
    };
  }
  const lifecycle = (gameWeek != null && totalGW != null && totalGW > 0) ? gameWeek / totalGW : 0;
  const late = lifecycle > 0.75;`;

if (src.includes('function scoreMotivation({ homePosition, awayPosition, homePoints, awayPoints, totalTeams = 20, gameWeek, totalGW = 38 }) {\n  const lifecycle = gameWeek / totalGW;')) {
  src = src.replace(
    'function scoreMotivation({ homePosition, awayPosition, homePoints, awayPoints, totalTeams = 20, gameWeek, totalGW = 38 }) {\n  const lifecycle = gameWeek / totalGW;\n  const late = lifecycle > 0.75;',
    newScoreMotivation
  );
  console.log('2. scoreMotivation null guard');
} else {
  // Try regex
  src = src.replace(
    /function scoreMotivation\(\{ homePosition, awayPosition, homePoints, awayPoints, totalTeams = 20, gameWeek, totalGW = 38 \}\) \{\s*const lifecycle = gameWeek \/ totalGW;\s*const late = lifecycle > 0\.75;/,
    newScoreMotivation
  );
  console.log('2. scoreMotivation null guard (regex)');
}

// ─── 3. scoreStarPower: null guard ────────────────────────────────────────────
src = src.replace(
  `function scoreStarPower(homeIntegrity = 85, awayIntegrity = 85, homeAbsences = [], awayAbsences = []) {`,
  `function scoreStarPower(homeIntegrity = null, awayIntegrity = null, homeAbsences = [], awayAbsences = []) {
  if (homeIntegrity == null || awayIntegrity == null) {
    return { score: null, available: false, evidenceStatus: 'MISSING', homeEffective: null, awayEffective: null, edge: 'NEUTRAL', assessment: 'Required inputs unavailable \u2014 squad integrity missing.' };
  }`
);
console.log('3. scoreStarPower null guard');

// ─── 4. scorePace: null guard ────────────────────────────────────────────────
src = src.replace(
  `function scorePace(homeConv = 10, awayConv = 10, homeShotsPerGame = 12, awayShotsPerGame = 10) {`,
  `function scorePace(homeConv = null, awayConv = null, homeShotsPerGame = null, awayShotsPerGame = null) {
  if (homeShotsPerGame == null || awayShotsPerGame == null) {
    return { score: null, available: false, evidenceStatus: 'MISSING', edge: 'NEUTRAL', assessment: 'Required inputs unavailable \u2014 shots data missing.' };
  }`
);
console.log('4. scorePace null guard');

// ─── 5. scoreHomeAdvantage: null guard for possession ────────────────────────
src = src.replace(
  `function scoreHomeAdvantage(homePossession = 50, homeShotsPerGame = 11, awayShotsPerGame = 11, venue = null, status = 'NS') {
  let score = 55; // Baseline: ~5% home win rate boost (literature consensus)
  if (status !== 'NS' && homePossession > 0) {`,
  `function scoreHomeAdvantage(homePossession = null, homeShotsPerGame = null, awayShotsPerGame = null, venue = null, status = 'NS') {
  let score = 55; // Baseline: ~5% home win rate boost (literature consensus)
  if (status !== 'NS' && homePossession != null && homePossession > 0) {`
);
console.log('5. scoreHomeAdvantage null guard');

// Fix shot ratio check to guard against null
src = src.replace(
  `  if (homeShotsPerGame > 0 && awayShotsPerGame > 0) {
    const shotRatio = homeShotsPerGame / (homeShotsPerGame + awayShotsPerGame);`,
  `  if (homeShotsPerGame != null && awayShotsPerGame != null && homeShotsPerGame > 0 && awayShotsPerGame > 0) {
    const shotRatio = homeShotsPerGame / (homeShotsPerGame + awayShotsPerGame);`
);
console.log('5b. scoreHomeAdvantage shot ratio null guard');

writeFileSync('backend/src/services/agent47Service.js', src, 'utf8');
console.log('\nagent47Service.js written successfully');

// Verify
const verify = readFileSync('backend/src/services/agent47Service.js', 'utf8');
console.log('\nVerification:');
console.log('  null position default:', verify.includes('homePosition = null, awayPosition = null'));
console.log('  null squad default:', verify.includes('homeSquadIntegrity = null, awaySquadIntegrity = null'));
console.log('  null possession default:', verify.includes('homePossession = null,'));
console.log('  null shots default:', verify.includes('homeShotsPerGame = null, awayShotsPerGame = null,'));
console.log('  motivation null guard:', verify.includes('homePosition == null || awayPosition == null'));
