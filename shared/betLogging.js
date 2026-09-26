/**
 * Bet logging rules (V10.7).
 * New bets must carry the stake and the SportyBet price actually taken, so
 * profit/loss can be computed. Practice ("paper") bets are recorded but kept
 * out of real-money statistics. Existing records are never rewritten: a
 * record without `paper` is treated as a real-money bet, exactly as before.
 */
export const DEFAULT_BOOKMAKER = 'SportyBet';
export const MAX_STAKE = 100_000_000;
export const MAX_ODDS = 1000;

export function isPaperBet(bet) {
  return bet?.paper === true;
}

export function parsePaperFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

/** @returns {{ ok: true, stake: number, odds: number, paper: boolean, bookmaker: string } | { ok: false, error: string }} */
export function validateBetStakeAndOdds(body = {}) {
  const stake = Number(body?.stake);
  const odds = Number(body?.odds);
  if (body?.stake == null || body?.stake === '' || !Number.isFinite(stake) || stake <= 0 || stake > MAX_STAKE) {
    return { ok: false, error: 'Stake is required: enter the amount you placed (greater than 0).' };
  }
  if (body?.odds == null || body?.odds === '' || !Number.isFinite(odds) || odds <= 1 || odds > MAX_ODDS) {
    return { ok: false, error: 'SportyBet odds are required: enter the decimal odds you got (greater than 1.00).' };
  }
  const bookmaker = String(body?.bookmaker || DEFAULT_BOOKMAKER).trim().slice(0, 40) || DEFAULT_BOOKMAKER;
  return { ok: true, stake: Math.round(stake * 100) / 100, odds: Math.round(odds * 1000) / 1000, paper: parsePaperFlag(body?.paper), bookmaker };
}

/** Split bets into real-money and practice lists. */
export function splitPaperBets(allBets = []) {
  const real = [];
  const paper = [];
  for (const b of Array.isArray(allBets) ? allBets : []) (isPaperBet(b) ? paper : real).push(b);
  return { real, paper };
}

/** Small summary for practice bets, reported next to (never inside) real stats. */
export function summarizePaperBets(paper = []) {
  const settled = paper.filter((b) => b.result === 'won' || b.result === 'lost');
  const won = settled.filter((b) => b.result === 'won').length;
  let netProfit = 0;
  for (const b of settled) {
    const stake = Number(b.stake), odds = betSettlementOdds(b);
    if (!(stake > 0) || !(odds > 1)) continue;
    netProfit += b.result === 'won' ? stake * (odds - 1) : -stake;
  }
  return {
    total: paper.length,
    settled: settled.length,
    won,
    lost: settled.length - won,
    winRate: settled.length ? +((won / settled.length) * 100).toFixed(1) : null,
    netProfit: Math.round(netProfit),
  };
}

// ─── Doubles (V10.8) ─────────────────────────────────────────────────────────
// A double is ONE bet slip with two legs. Old single records have no
// `slipType` and keep working exactly as before.
export const SLIP_SINGLE = 'single';
export const SLIP_DOUBLE = 'double';
export const SLIP_TREBLE = 'treble'; // V10.9: 3-leg slips from "Build my double"
const LEGS_FOR = { [SLIP_DOUBLE]: 2, [SLIP_TREBLE]: 3 };
/** Fixture statuses where SportyBet-style rules void a leg instead of settling it. */
export const VOID_FIXTURE_STATUSES = new Set(['CANC', 'ABD', 'AWD', 'WO']);

/** True for any multi-leg slip (double or treble). */
export function isDoubleSlip(bet) {
  return (bet?.slipType === SLIP_DOUBLE || bet?.slipType === SLIP_TREBLE) && Array.isArray(bet?.legs);
}
export const isMultiSlip = isDoubleSlip;

/** Odds that decide the payout: a double reduced by a void leg pays at `effectiveOdds`. */
export function betSettlementOdds(bet) {
  const eff = Number(bet?.effectiveOdds);
  if (Number.isFinite(eff) && eff > 1) return eff;
  return Number(bet?.odds);
}

/** Profit/loss in Naira for a settled slip; null when it cannot be computed yet. */
export function slipProfit(bet) {
  const stake = Number(bet?.stake);
  const odds = betSettlementOdds(bet);
  const r = String(bet?.result || '').toLowerCase();
  if (!(stake > 0)) return null;
  if (r === 'void') return 0;
  if (!(odds > 1)) return null;
  if (r === 'won') return stake * (odds - 1);
  if (r === 'lost') return -stake;
  return null;
}

function optionalOdds(value) {
  if (value == null || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 1 || n > MAX_ODDS) return { ok: false };
  return { ok: true, value: Math.round(n * 1000) / 1000 };
}

/**
 * Validate a double from the "I played this" form.
 * `isSettleable(marketKey)` is injected so this file stays dependency-free.
 */
export function validateDoubleSlip(body = {}, { isSettleable = () => true } = {}) {
  const legsIn = Array.isArray(body?.legs) ? body.legs : [];
  const slipType = body?.slipType === SLIP_TREBLE ? SLIP_TREBLE : SLIP_DOUBLE;
  if (legsIn.length !== LEGS_FOR[slipType]) {
    return { ok: false, error: slipType === SLIP_TREBLE ? 'A treble needs exactly three picks.' : 'A double needs exactly two picks.' };
  }
  const legs = [];
  for (const [i, leg] of legsIn.entries()) {
    const label = ['first pick', 'second pick', 'third pick'][i];
    if (!leg?.matchId || !leg?.selection || !leg?.marketKey) return { ok: false, error: `The ${label} is missing its match or selection.` };
    if (!isSettleable(String(leg.marketKey))) return { ok: false, error: `The ${label} is in a market the app cannot settle yet.` };
    const odds = optionalOdds(leg.odds);
    if (!odds.ok) return { ok: false, error: `The ${label}'s own odds must be a decimal number above 1.00 (or left empty).` };
    legs.push({ ...leg, matchId: leg.matchId, marketKey: String(leg.marketKey), selection: String(leg.selection), odds: odds.value });
  }
  if (new Set(legs.map((l) => String(l.matchId))).size !== legs.length) {
    return { ok: false, error: 'Each pick must come from a different match.' };
  }
  const base = validateBetStakeAndOdds({ ...body, odds: body?.combinedOdds ?? body?.odds });
  if (!base.ok) {
    return { ok: false, error: base.error.startsWith('SportyBet odds')
      ? 'Combined SportyBet odds are required: enter the total odds shown on your slip (greater than 1.00).'
      : base.error };
  }
  return { ok: true, slipType, legs, combinedOdds: base.odds, stake: base.stake, paper: base.paper, bookmaker: base.bookmaker };
}

/**
 * Settle a double from its legs.
 *  - any leg lost            → lost
 *  - both legs won           → won at the combined odds
 *  - both legs void          → void (stake returned)
 *  - one void, other won     → a single on the other leg: at that leg's odds if
 *                              known, else combined ÷ void leg's odds if known,
 *                              else "review" (needs a manual check)
 *  - otherwise               → pending
 */
export function settleDoubleSlip(legs = [], combinedOdds) {
  const results = legs.map((l) => String(l?.result || 'pending').toLowerCase());
  if (results.includes('lost')) return { result: 'lost', effectiveOdds: null, needsReview: false };
  if (results.includes('pending') || results.length < 2) return { result: 'pending', effectiveOdds: null, needsReview: false };
  if (results.every((r) => r === 'won')) return { result: 'won', effectiveOdds: Number(combinedOdds) || null, needsReview: false };
  if (results.every((r) => r === 'void')) return { result: 'void', effectiveOdds: null, needsReview: false };
  // Some legs void, the rest won: pay on the legs that stood.
  const stood = legs.filter((_, i) => results[i] === 'won');
  const voided = legs.filter((_, i) => results[i] === 'void');
  const product = (arr) => arr.reduce((acc, l) => acc * Number(l?.odds), 1);
  if (stood.every((l) => Number(l?.odds) > 1)) {
    return { result: 'won', effectiveOdds: Math.round(product(stood) * 1000) / 1000, needsReview: false, reducedToSingle: stood.length === 1 };
  }
  const combined = Number(combinedOdds);
  if (voided.every((l) => Number(l?.odds) > 1) && combined > 1) {
    const eff = Math.round((combined / product(voided)) * 1000) / 1000;
    if (eff > 1) return { result: 'won', effectiveOdds: eff, needsReview: false, reducedToSingle: stood.length === 1 };
  }
  return { result: 'review', effectiveOdds: null, needsReview: true,
    note: 'A leg was void and the others won, but the leg odds were not recorded. Check the payout on SportyBet.' };
}
