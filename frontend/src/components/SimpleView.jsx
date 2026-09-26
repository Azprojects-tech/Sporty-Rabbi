import React, { useMemo, useState } from 'react';
import { apiService } from '../services/api';
import { SIMPLE_MARKETS, suggestCombos, comboTotals } from '../../../shared/simpleCard.js';

const box = { background: '#0a0d15', border: '1px solid #1e2535', borderRadius: 10, padding: '12px 14px' };
const input = { background: '#0a0d15', border: '1px solid #2d3748', borderRadius: 4, color: '#e2e8f0', padding: '4px 6px', fontSize: 12 };
const btn = { border: '1px solid #006833', background: '#001f0e', color: '#00b859', borderRadius: 6, padding: '6px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer' };
const pct = (v) => `${Math.round(Number(v))}%`;

function kickoffText(m) {
  const t = Date.parse(m?.kickoffUTC || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}

function Chance({ label, market }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '3px 0' }}>
      <span style={{ color: '#8b9ab3' }}>{label}</span>
      {market
        ? <strong style={{ color: market.chance >= 70 ? '#00b859' : market.chance >= 50 ? '#e2e8f0' : '#94a3b8' }}>{pct(market.chance)}</strong>
        : <span style={{ color: '#64748b' }}>No prediction</span>}
    </div>
  );
}

/** One clean card per game: the chance each everyday bet comes in. */
export function GameCard({ match, onDetails }) {
  const mk = match?.simpleCard?.markets || {};
  const corners = match?.corners || match?.simpleCard?.corners || null;
  return (
    <div style={{ ...box, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: '#e2e8f0' }}>{match.home} <span style={{ color: '#4a5568', fontWeight: 400 }}>vs</span> {match.away}</div>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>{match.league}{kickoffText(match) ? ` · ${kickoffText(match)}` : ''}</div>
      <Chance label="Over 1.5 goals" market={mk.over15} />
      <Chance label="Over 2.5 goals" market={mk.over25} />
      <div style={{ fontSize: 13, padding: '3px 0' }}>
        <div style={{ color: '#8b9ab3', marginBottom: 2 }}>Win</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[['home_win', match.home || 'Home'], ['draw', 'Draw'], ['away_win', match.away || 'Away']].map(([k, name]) => (
            <span key={k} style={{ color: '#cbd5e1' }}>
              {name}: {mk[k] ? <strong>{pct(mk[k].chance)}</strong> : <span style={{ color: '#64748b' }}>No prediction</span>}
            </span>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '3px 0' }}>
        <span style={{ color: '#8b9ab3' }}>Corners</span>
        {corners?.chance != null
          ? <strong style={{ color: '#e2e8f0' }}>Over {corners.line}: {pct(corners.chance)}</strong>
          : corners?.status === 'NO_PREDICTION'
            ? <span style={{ color: '#64748b' }}>No prediction</span>
            : <span style={{ color: '#64748b' }}>Coming soon</span>}
      </div>
      <button onClick={() => onDetails?.(match)} style={{ ...btn, alignSelf: 'flex-start', marginTop: 6, background: '#131826', borderColor: '#2d3748', color: '#8b9ab3' }}>
        Details
      </button>
    </div>
  );
}

function LogComboForm({ combo, legs, totals, onDone }) {
  const [combined, setCombined] = useState(String(totals.odds));
  const [stake, setStake] = useState('');
  const [paper, setPaper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function save(e) {
    e.preventDefault();
    if (!(Number(stake) > 0)) { setMsg('Enter the stake you placed (₦).'); return; }
    if (!(Number(combined) > 1)) { setMsg('Enter the combined SportyBet odds from your slip.'); return; }
    setBusy(true); setMsg('');
    try {
      await apiService.logPlayedRecommendation({
        slipType: legs.length === 3 ? 'treble' : 'double',
        combinedOdds: Number(combined), stake: Number(stake), paper, bookmaker: 'SportyBet',
        legs: legs.map((l) => ({
          matchId: l.matchId, predictionId: l.predictionId, home: l.home, away: l.away, league: l.league,
          leagueId: l.leagueId, leagueCountry: l.leagueCountry, kickoffUTC: l.kickoffUTC,
          marketKey: l.marketKey, selection: l.selection, modelProbability: l.stated,
          odds: Number(l.userOdds) > 1 ? Number(l.userOdds) : null, // only real SportyBet prices
        })),
      });
      onDone?.(`Saved your ${legs.length === 3 ? 'treble' : 'double'}${paper ? ' (practice)' : ''}. You'll find it in Record → My bets.`);
    } catch (err) {
      setMsg(err.response?.data?.error || 'Could not save this bet.');
    } finally { setBusy(false); }
  }
  return (
    <form onSubmit={save} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', marginTop: 8 }}>
      <label style={{ fontSize: 11, color: '#8b9ab3' }}>Combined SportyBet odds
        <input type="number" min="1.01" step="0.01" required value={combined} onChange={(e) => setCombined(e.target.value)} style={{ ...input, display: 'block', width: 90 }} />
      </label>
      <label style={{ fontSize: 11, color: '#8b9ab3' }}>Stake (₦)
        <input type="number" min="1" step="any" required value={stake} onChange={(e) => setStake(e.target.value)} style={{ ...input, display: 'block', width: 90 }} />
      </label>
      <label style={{ fontSize: 11, color: '#8b9ab3', display: 'flex', gap: 4, alignItems: 'center' }}>
        <input type="checkbox" checked={paper} onChange={(e) => setPaper(e.target.checked)} /> Practice (no real money)
      </label>
      <button type="submit" disabled={busy} style={btn}>{busy ? 'Saving…' : 'Save'}</button>
      {msg && <div style={{ width: '100%', fontSize: 11, color: '#fbbf24' }}>{msg}</div>}
    </form>
  );
}

function ComboCard({ combo }) {
  const [userOdds, setUserOdds] = useState({});
  const [logging, setLogging] = useState(false);
  const [saved, setSaved] = useState('');
  const legs = combo.legs.map((l) => ({ ...l, userOdds: userOdds[l.key] ?? '' }));
  const totals = comboTotals(legs);
  return (
    <div style={{ ...box, minWidth: 260, flex: '1 1 300px' }}>
      {legs.map((l) => (
        <div key={l.key} style={{ padding: '5px 0', borderBottom: '1px solid #131826' }}>
          <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 700 }}>{l.home} vs {l.away}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: '#cbd5e1' }}>
            <span>{l.selection}</span>
            <span style={{ color: '#8b9ab3' }}>chance {pct(l.chance)}</span>
            <span style={{ color: '#8b9ab3' }}>odds {l.odds.toFixed(2)}{l.estimate ? ' (estimate)' : ''}</span>
            <input type="number" min="1.01" step="0.01" placeholder="SportyBet odds" aria-label={`SportyBet odds for ${l.selection}`}
              value={l.userOdds} onChange={(e) => setUserOdds((u) => ({ ...u, [l.key]: e.target.value }))} style={{ ...input, width: 110 }} />
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 13 }}>
        <span style={{ color: '#8b9ab3' }}>Chance all win: <strong style={{ color: '#00b859' }}>{pct(totals.chance)}</strong></span>
        <span style={{ color: '#8b9ab3' }}>Combined odds: <strong style={{ color: '#e2e8f0' }}>{totals.odds.toFixed(2)}</strong>{totals.estimate ? ' (estimate)' : ''}</span>
      </div>
      {saved ? <div style={{ fontSize: 11, color: '#00b859', marginTop: 6 }}>{saved}</div> : (
        logging
          ? <LogComboForm combo={combo} legs={legs} totals={totals} onDone={(m) => { setSaved(m); setLogging(false); }} />
          : <button onClick={() => setLogging(true)} style={{ ...btn, marginTop: 8 }}>I played this</button>
      )}
    </div>
  );
}

/** Suggested doubles/trebles of the strongest picks, aiming at about 2.0 and 3.0 odds. */
export function BuildMyDouble({ matches }) {
  const combos = useMemo(() => suggestCombos(matches), [matches]);
  const groups = [2, 3].map((t) => ({ target: t, list: combos.filter((c) => c.target === t) }));
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0', marginBottom: 4 }}>Build my double</div>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
        The strongest picks from different games, put together to reach about 2.0 or 3.0 odds. "Chance all win" multiplies each pick's chance.
        Odds marked "estimate" are worked out from the chance — type the real SportyBet odds to update the total.
      </div>
      {combos.length === 0 && <div style={{ fontSize: 12, color: '#64748b' }}>No suitable combinations right now.</div>}
      {groups.filter((g) => g.list.length).map((g) => (
        <div key={g.target} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: '#8b9ab3', fontWeight: 700, marginBottom: 6 }}>About {g.target.toFixed(1)} odds</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {g.list.map((c) => <ComboCard key={c.legs.map((l) => l.key).join('+')} combo={c} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SimpleView({ matches = [], allMatches = [], onDetails }) {
  const [shown, setShown] = useState(40);
  const upcoming = useMemo(() => matches
    .filter((m) => m?.analysis && (!m.status || m.status === 'NS' || m.status === 'TBD'))
    .sort((a, b) => String(a.kickoffUTC || '').localeCompare(String(b.kickoffUTC || ''))), [matches]);
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
      <BuildMyDouble matches={allMatches} />
      <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0', margin: '6px 0 4px' }}>Today's games</div>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
        Each figure is the chance that bet comes in, corrected using how SportyRabbi's past picks actually turned out. Press Details for the full analysis.
      </div>
      {upcoming.length === 0 && <div style={{ fontSize: 12, color: '#64748b' }}>No upcoming games with a prediction yet.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
        {upcoming.slice(0, shown).map((m) => <GameCard key={m.id} match={m} onDetails={onDetails} />)}
      </div>
      {upcoming.length > shown && (
        <button onClick={() => setShown((n) => n + 40)} style={{ ...btn, marginTop: 12 }}>Show more games ({upcoming.length - shown} more)</button>
      )}
    </div>
  );
}
