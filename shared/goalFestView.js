export function goalFestView(match = {}, signals = [], now = Date.now()) {
  if (!['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT'].includes(String(match.status || '').toUpperCase())) return null;
  if (['HT', 'BT', 'P', 'SUSP', 'INT'].includes(String(match.status || '').toUpperCase()))
    return { active: false, score: null, status: 'PAUSED', summary: 'Goal Fest is paused while play is stopped.' };
  const fresh = signals.filter(Boolean).filter((s) => {
    const age = now - Date.parse(s.evaluatedAt);
    return Number.isFinite(age) && age >= 0 && age <= 450000
      && s.observedScore === match.score;
  }).sort((a, b) => Date.parse(b.evaluatedAt) - Date.parse(a.evaluatedAt))[0];
  return fresh || { active: false, score: null, status: 'WAITING_FOR_SCAN',
    summary: 'Waiting for verified live statistics. Open the match to check its evidence.' };
}
