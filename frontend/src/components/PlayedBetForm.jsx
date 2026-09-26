import React, { useMemo, useState } from 'react';
import { apiService } from '../services/api';

const input = { display: 'block', marginTop: 2, background: '#0a0d15', border: '1px solid #2d3748', borderRadius: 4, color: '#e2e8f0', padding: '4px 6px', fontSize: 11 };
const label = { fontSize: 10, color: '#8b9ab3' };
const pctText = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Math.round(Number(v))}%`);

/** Corrected chance, fair market chance, minimum odds and the overrated warning for one pick. */
export function PriceCheck({ check }) {
  if (!check) return null;
  const chip = { fontSize: 10, background: '#0f1117', border: '1px solid #1e2535', borderRadius: 4, padding: '2px 6px' };
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
        <span style={{ ...chip, color: '#e2e8f0', fontWeight: 800 }}
          title="What picks like this have actually won in SportyRabbi's own record, recalculated every day.">
          Corrected chance {check.correctedChance != null ? `${pctText(check.correctedChance)}` : 'not available yet'}
        </span>
        <span style={{ ...chip, color: '#8b9ab3' }}
          title="The bookmaker's price with its built-in profit margin taken out.">
          {check.fairMarketChance != null
            ? `Fair market chance ${pctText(check.fairMarketChance)}${check.bookmaker ? ` (${check.bookmaker})` : ''}`
            : 'Fair market chance: no market price'}
        </span>
        {check.warning && (
          <span style={{ ...chip, color: '#fbbf24', background: '#1c1200', border: '1px solid #78350f', fontWeight: 800 }}
            title={check.marketHistory ? `This kind of pick was stated at ${pctText(check.marketHistory.statedAvg)} on average but won ${pctText(check.marketHistory.actualRate)}.` : undefined}>
            ⚠ {check.warning}
          </span>
        )}
      </div>
      {check.minimumOdds != null && (
        <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 5 }}>
          Minimum SportyBet odds worth taking: <strong style={{ color: '#00b859' }}>{check.minimumOdds.toFixed(2)}</strong>
          {check.noMarketPrice && <span style={{ color: '#64748b' }}> · no market price</span>}
          {check.correctedChance == null && <span style={{ color: '#64748b' }}> (from the model's own figure)</span>}
        </div>
      )}
    </div>
  );
}

function legPayload(match, analysis, rec, odds) {
  return {
    predictionId: match?.predictionId || null,
    matchId: match?.id,
    home: match?.home,
    away: match?.away,
    league: match?.league,
    leagueId: match?.leagueId || 0,
    leagueCountry: match?.leagueCountry || '',
    matchType: match?.matchType || 'League',
    kickoffUTC: match?.kickoffUTC || null,
    marketKey: rec.marketKey,
    selection: rec.selection,
    confidence: rec.confidence,
    modelProbability: rec.modelProbability ?? rec.confidence,
    displayedOdds: analysis?.oddsSnapshot || null,
    odds: odds === '' ? null : odds,
  };
}

/**
 * "I played this" form. Single: this pick, SportyBet odds, stake.
 * Double: this pick plus a second pick from today's other games, the combined
 * odds from the slip, optional odds for each leg, and stake.
 */
export default function PlayedBetForm({ match, analysis, rec, otherPicks = [], onSaved }) {
  const [slipType, setSlipType] = useState('single');
  const [stake, setStake] = useState('');
  const shownOdds = analysis?.oddsSnapshot?.odds?.[rec.marketKey];
  const [odds, setOdds] = useState(Number.isFinite(Number(shownOdds)) ? String(shownOdds) : '');
  const [combinedOdds, setCombinedOdds] = useState('');
  const [secondOdds, setSecondOdds] = useState('');
  const [search, setSearch] = useState('');
  const [secondKey, setSecondKey] = useState('');
  const [paper, setPaper] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return otherPicks
      .filter((p) => String(p.match?.id) !== String(match?.id))
      .filter((p) => !q || `${p.match?.home} ${p.match?.away} ${p.match?.league} ${p.rec?.selection}`.toLowerCase().includes(q))
      .slice(0, 200);
  }, [otherPicks, search, match?.id]);
  const second = otherPicks.find((p) => p.key === secondKey) || null;

  async function submit(e) {
    e.preventDefault();
    const stakeN = Number(stake);
    if (!Number.isFinite(stakeN) || stakeN <= 0) { setMessage('Enter the stake you placed (₦).'); return; }
    const payload = { stake: stakeN, bookmaker: 'SportyBet', paper,
      dailySignalScore: analysis?.dailySignal?.score ?? match?.dailySignal?.score ?? null,
      analysisVersion: analysis?.analysisVersion || null, analysisTimestamp: analysis?.analysisTimestamp || null };
    if (slipType === 'single') {
      const oddsN = Number(odds);
      if (!Number.isFinite(oddsN) || oddsN <= 1) { setMessage('Enter the SportyBet odds you got (e.g. 1.85).'); return; }
      Object.assign(payload, legPayload(match, analysis, rec, ''), {
        odds: oddsN, competitionFamily: rec?.evidence?.competitionFamily || null,
      });
    } else {
      const combined = Number(combinedOdds);
      if (!second) { setMessage('Choose the second pick of your double.'); return; }
      if (!Number.isFinite(combined) || combined <= 1) { setMessage('Enter the combined SportyBet odds shown on your slip (e.g. 2.40).'); return; }
      for (const v of [odds, secondOdds]) {
        if (v !== '' && !(Number(v) > 1)) { setMessage("Each pick's own odds must be above 1.00, or leave it empty."); return; }
      }
      Object.assign(payload, {
        slipType: 'double',
        combinedOdds: combined,
        legs: [
          legPayload(match, analysis, rec, odds === '' ? '' : Number(odds)),
          legPayload(second.match, { oddsSnapshot: second.match?.analysis?.oddsSnapshot || second.match?.oddsSnapshot || null }, second.rec, secondOdds === '' ? '' : Number(secondOdds)),
        ],
      });
    }
    setBusy(true);
    setMessage('');
    try {
      await apiService.logPlayedRecommendation(payload);
      onSaved?.(slipType === 'single'
        ? `Recorded: ${rec.selection}${paper ? ' (practice)' : ''}`
        : `Recorded double: ${rec.selection} + ${second.rec.selection}${paper ? ' (practice)' : ''}`);
    } catch (err) {
      setMessage(err.response?.data?.error || 'Could not record this bet.');
    } finally {
      setBusy(false);
    }
  }

  const toggle = (value, text) => (
    <button type="button" onClick={() => { setSlipType(value); setMessage(''); }}
      style={{ border: '1px solid ' + (slipType === value ? '#006833' : '#2d3748'), background: slipType === value ? '#001f0e' : '#131826',
        color: slipType === value ? '#00b859' : '#8b9ab3', borderRadius: 5, padding: '4px 10px', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}>
      {text}
    </button>
  );

  return (
    <form onSubmit={submit} style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={label}>Bet type</span>
        {toggle('single', 'Single')}
        {toggle('double', 'Double')}
      </div>

      {slipType === 'double' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={label}>
            Second pick (search today's games)
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Team, league or pick"
              style={{ ...input, width: '100%' }} />
          </label>
          <select value={secondKey} onChange={(e) => setSecondKey(e.target.value)} size={Math.min(6, Math.max(2, candidates.length))}
            aria-label="Second pick" style={{ ...input, width: '100%' }}>
            {candidates.length === 0 && <option value="" disabled>No other picks match</option>}
            {candidates.map((p) => (
              <option key={p.key} value={p.key}>
                {p.match.home} vs {p.match.away} · {p.rec.selection}
                {p.rec.priceCheck?.correctedChance != null ? ` · corrected ${pctText(p.rec.priceCheck.correctedChance)}` : ''}
              </option>
            ))}
          </select>
          {second && (
            <div style={{ fontSize: 10, color: '#cbd5e1' }}>
              Leg 2: {second.match.home} vs {second.match.away} — {second.rec.selection}
              {second.rec.priceCheck?.warning ? <span style={{ color: '#fbbf24' }}> · ⚠ {second.rec.priceCheck.warning}</span> : null}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'flex-end' }}>
        {slipType === 'double' && (
          <label style={label}>
            Combined SportyBet odds
            <input type="number" min="1.01" step="0.01" required value={combinedOdds} onChange={(e) => setCombinedOdds(e.target.value)}
              style={{ ...input, width: 90 }} />
          </label>
        )}
        <label style={label}>
          {slipType === 'single' ? 'SportyBet odds' : 'This pick’s odds (optional)'}
          <input type="number" min="1.01" step="0.01" required={slipType === 'single'} value={odds} onChange={(e) => setOdds(e.target.value)}
            style={{ ...input, width: 80 }} />
        </label>
        {slipType === 'double' && (
          <label style={label}>
            Second pick’s odds (optional)
            <input type="number" min="1.01" step="0.01" value={secondOdds} onChange={(e) => setSecondOdds(e.target.value)}
              style={{ ...input, width: 80 }} />
          </label>
        )}
        <label style={label}>
          Stake (₦)
          <input type="number" min="1" step="any" required value={stake} onChange={(e) => setStake(e.target.value)}
            style={{ ...input, width: 90 }} />
        </label>
      </div>
      <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 4 }}>
        <input type="checkbox" checked={paper} onChange={(e) => setPaper(e.target.checked)} />
        Practice (no real money)
      </label>
      {message && <div style={{ fontSize: 10, color: '#fbbf24' }} role="status">{message}</div>}
      <div>
        <button type="submit" disabled={busy}
          style={{ border: '1px solid #006833', background: '#001f0e', color: '#00b859', borderRadius: 6, padding: '6px 9px', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}>
          {busy ? 'SAVING…' : slipType === 'single' ? 'SAVE SINGLE' : 'SAVE DOUBLE'}
        </button>
      </div>
    </form>
  );
}
