import { describeMatchClock, describeScorePressure } from '../../../shared/matchClock.js';

const number = (v) => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const date = (v) => Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;

// Score reconciliation distinguishes verified no-goal matches from missing event coverage.
// Shoot-out penalties and disallowed goals are never counted as playing-time goals.
export function summarizeLateGoals(teamId, fixtures = [], eventResults = new Map()) {
  let sampled = 0, scored = 0, conceded = 0;
  const examples = [];
  for (const f of fixtures) {
    const result = eventResults.get(String(f.id));
    if (!result || !Array.isArray(result.events)) continue;
    const goals = result.events.filter((e) => e.type === 'Goal' && !/missed|disallowed|cancelled/i.test(e.detail || '')
      && number(e.time?.elapsed) != null && number(e.time.elapsed) <= 90);
    const h = number(f.homeGoals), a = number(f.awayGoals);
    if (h == null || a == null || goals.filter((e) => String(e.team?.id) === String(f.homeTeamId)).length !== h
      || goals.filter((e) => String(e.team?.id) === String(f.awayTeamId)).length !== a) continue;
    sampled++;
    const late = goals.filter((e) => Number(e.time.elapsed) >= 80);
    const own = late.filter((e) => String(e.team?.id) === String(teamId));
    const opp = late.filter((e) => String(e.team?.id) !== String(teamId));
    if (own.length) scored++;
    if (opp.length) conceded++;
    for (const e of late) examples.push({ fixtureId: f.id, date: f.date,
      action: String(e.team?.id) === String(teamId) ? 'scored' : 'conceded',
      minute: `${e.time.elapsed}${e.time.extra ? `+${e.time.extra}` : ''}` });
  }
  return { sampled, requested: fixtures.length, scored, conceded, fromMinute: 80,
    examples: examples.slice(0, 6) };
}

function recordText(name, record, previous) {
  const played = number(record?.played), wins = number(record?.wins), draws = number(record?.draws);
  if (!played || wins == null || draws == null) return `${name}: current-season record unavailable.`;
  const ppg = (wins * 3 + draws) / played;
  let text = `${name}: ${played} league games, ${wins} wins, ${draws} draws (${ppg.toFixed(2)} points/game).`;
  const p = number(previous?.played), w = number(previous?.wins), d = number(previous?.draws);
  if (p && w != null && d != null) {
    const prior = (w * 3 + d) / p;
    const diff = ppg - prior;
    text += ` ${Math.abs(diff) < 0.05 ? 'Similar to' : diff > 0 ? 'Better than' : 'Worse than'} last season's ${prior.toFixed(2)} points/game over ${p} games.`;

  } else text += ' Last-season comparison unavailable.';
  return text;
}

function teamChanges(name, id, info, seasonStart, asOf, transferStart = seasonStart) {
  const parts = [];
  const careers = (info?.coaches || []).flatMap((coach) => (coach.career || [])
    .filter((c) => String(c.team?.id) === String(id) && date(c.start) != null && date(c.start) <= asOf)
    .map((c) => ({ name: coach.name, start: c.start, end: c.end })));
  const current = careers.filter((c) => !c.end || (date(c.end) != null && date(c.end) >= asOf))
    .sort((a, b) => date(b.start) - date(a.start))[0];
  if (current) {
    parts.push(`${name}: coach ${current.name}, recorded tenure began ${current.start}.`);
    const predecessor = careers.filter((c) => c.end && date(c.end) < date(current.start)
      && c.name !== current.name).sort((a, b) => date(b.end) - date(a.end))[0];
    if (predecessor && transferStart != null && date(current.start) >= transferStart)
      parts.push(`Recorded coaching change ${seasonStart != null && date(current.start) >= seasonStart ? 'this season' : 'since last season'} from ${predecessor.name}.`);
  } else parts.push(`${name}: current coach: unavailable.`);
  if (transferStart != null && Array.isArray(info?.transfers)) {
    const incoming = info.transfers.flatMap((p) => (p.transfers || [])
      .filter((t) => String(t.teams?.in?.id) === String(id) && date(t.date) != null
        && date(t.date) >= transferStart && date(t.date) <= asOf)
      .map((t) => ({ name: p.player?.name, id: p.player?.id, date: t.date }))).filter((p) => p.name);
    const unique = [...new Map(incoming.map((p) => [p.id || p.name, p])).values()];
    parts.push(`${unique.length} recorded arrivals since ${new Date(transferStart).toISOString().slice(0, 10)}${unique.length ? `: ${unique.slice(0, 4).map((p) => p.name).join(', ')}${unique.length > 4 ? ', …' : ''}` : ''}.`);

  } else parts.push('Season arrivals unavailable.');
  return parts.join(' ');
}

export function buildGroundedAnalystNote(analysis = {}, match = {}, evidence = {}) {
  const sections = [{ label: 'Match situation', text: `${describeMatchClock(match)} Score: ${match.score || 'unavailable'}.` }];
  if (['LIVE','1H','2H','ET'].includes(match.status)) sections.push({ label: 'Score pressure', text: describeScorePressure(match) });
  const pair = (obj) => number(obj?.home) != null && number(obj?.away) != null ? `${obj.home}–${obj.away}` : 'unavailable';
  if (['LIVE','1H','2H','HT','ET'].includes(match.status)) sections.push({ label: 'Evidence at selection',
    text: `Checked at ${match.matchMinutes ?? '?'}', score ${match.score || 'unavailable'}. Home–away: shots on target ${pair(match.shots)}, xG ${pair(match.xg)}. Match totals so far.` });
  const season = evidence.season;
  const asOf = date(match.kickoffUTC) ?? Date.now();
  const start = date(season?.start), end = date(season?.end);
  if (start != null && end != null && end > start && asOf >= start && asOf <= end) {
    const fraction = (asOf - start) / (end - start);
    sections.push({ label: 'Season stage', text: `${fraction < 0.25 ? 'Beginning' : fraction < 0.75 ? 'Middle' : 'Late stage'} of the recorded ${match.season == null ? '' : `${match.season} `}season (${season.start} to ${season.end}). Calendar stage.` });
  } else sections.push({ label: 'Season stage', text: 'Verified season dates unavailable.' });
  for (const side of ['home', 'away']) {
    const name = match[side] || side;
    const info = evidence[side] || {};
    const timing = info.lateGoals;
    sections.push({ label: `${name}: late goals`, text: timing?.sampled
      ? `From 80 minutes onward (including stoppage time), scored in ${timing.scored} and conceded in ${timing.conceded} of ${timing.sampled} verified recent league games.${timing.sampled < timing.requested ? ` Event coverage: ${timing.sampled}/${timing.requested} games.` : ''}`
      : 'Late-goal history unavailable: completed goal-event coverage is not verified.' });
    if (timing?.examples?.length) sections.push({ label: `${name}: examples`, text: timing.examples.slice(0, 3)
      .map((e) => `${e.date?.slice(0, 10)} ${e.action} at ${e.minute}'`).join('; ') });
    sections.push({ label: `${name}: season form`, text: evidence.competitionType === 'League'
      ? recordText(name, match[`${side}SeasonRecord`], info.previousRecord)
      : 'League season comparison unavailable until a league competition is verified.' });
    sections.push({ label: `${name}: team changes`, text: teamChanges(name, match[`${side}TeamId`], info, start, asOf,
      date(evidence.previousSeason?.end) ?? start) });
  }
  const gf = analysis.goalFest;
  const recommendation = (analysis.recommendations || []).find(r => r.marketKey && r.probability01 != null);
  if (recommendation) sections.push({ label: 'Rabbi selection', text:
    `${recommendation.selection}: ${(recommendation.probability01 * 100).toFixed(1)}%.${recommendation.value?.offeredOdds ? ` Odds ${recommendation.value.offeredOdds.toFixed(2)}.` : ' Odds unavailable.'}` });
  sections.push({ label: 'Goal Fest', text: gf?.summary || 'Live Goal Fest signal unavailable.' });

  return { text: sections.map((s) => `${s.label}: ${s.text}`).join('\n'), sections,
    provider: 'verified-evidence', evaluatedAt: new Date().toISOString(),
    evidenceStatus: evidence.status || 'partial' };
}
