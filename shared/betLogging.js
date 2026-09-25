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
    const stake = Number(b.stake), odds = Number(b.odds);
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
