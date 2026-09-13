export function describeMatchClock(match = {}) {
  const status = String(match.status || 'NS').toUpperCase();
  const minute = match.matchMinutes == null ? null : Number(match.matchMinutes);
  if (['FT', 'AET', 'PEN'].includes(status)) return 'Match finished. No playing time remains.';
  if (['PST', 'CANC', 'ABD', 'AWD', 'WO'].includes(status)) return 'Match postponed, cancelled or no longer in normal play. Remaining time is not applicable.';
  if (status === 'HT') return 'Half-time: about 45 minutes of normal time remain, plus stoppage time.';
  if (['SUSP', 'INT', 'BT', 'P'].includes(status)) return 'Play is paused or in a break. Remaining time cannot be confirmed.';
  if (!['LIVE', '1H', '2H', 'ET'].includes(status)) return 'Pre-match: the game has not started.';
  if (!Number.isFinite(minute) || minute <= 0) return 'Match live; the current minute is unavailable.';
  const end = status === 'ET' ? 120 : 90;
  if (minute >= end) return `${minute}' played. Stoppage time is in progress; its remaining length is unknown.`;
  return `${minute}' played: about ${end - minute} minutes of ${status === 'ET' ? 'extra' : 'normal'} time remain, plus stoppage time.`;
}

export function describeScorePressure(match = {}) {
  if (!['LIVE', '1H', '2H', 'ET'].includes(String(match.status || '').toUpperCase())) return 'Score pressure is not assessed while play is stopped or before kickoff.';
  const score = String(match.score || '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (!score) return 'Score pressure unavailable: verified score missing.';
  const gap = Number(score[1]) - Number(score[2]);
  if (!gap) return 'Scores level: neither team is protecting a lead.';
  return `${gap > 0 ? match.away : match.home} is chasing ${Math.abs(gap) === 1 ? 'an equaliser' : `a ${Math.abs(gap)}-goal deficit`}; ${gap > 0 ? match.home : match.away} is protecting the lead. This score state does not establish how either team will play.`;
}
