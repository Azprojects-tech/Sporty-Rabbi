import React, { useEffect, useMemo, useState } from 'react';
import { apiService } from '../services/api';
import { slipProfit } from '../../../shared/betLogging.js';

function ResultBadge({ result }) {
  const r = String(result || 'pending').toLowerCase();
  const won = r === 'won';
  const lost = r === 'lost';
  const other = r === 'void' ? 'VOID' : r === 'review' ? 'CHECK MANUALLY' : null;
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 800,
      borderRadius: 4,
      padding: '2px 6px',
      color: won ? '#00b859' : lost ? '#ef4444' : '#8b9ab3',
      background: won ? '#001f0e' : lost ? '#1a0000' : '#131826',
      border: '1px solid ' + (won ? '#00683355' : lost ? '#7f1d1d55' : '#1e2535'),
    }}>
      {won ? 'CORRECT' : lost ? 'WRONG' : other || 'PENDING'}
    </span>
  );
}

// Probabilities are stored unrounded (e.g. 63.48291); show one decimal.
function pct(value) {
  const n = Number(value);
  return value == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 10) / 10}%`;
}

function naira(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}₦${Math.abs(n).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
}

/** Profit/loss for a settled bet with a recorded stake and price; null otherwise. */
// Doubles pay stake × combined odds (or the reduced odds after a void leg).
export function betProfit(b) {
  return slipProfit(b);
}

function DoubleLegs({ legs = [] }) {
  return (
    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      {legs.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, color: '#94a3b8' }}>
          <span style={{ color: '#64748b' }}>Leg {i + 1}</span>
          <span style={{ color: '#cbd5e1' }}>{l.home} vs {l.away}</span>
          <span>· {l.selection}</span>
          {Number(l.odds) > 1 && <span>@ {Number(l.odds).toFixed(2)}</span>}
          {l.priceCheckAtLogging?.correctedChance != null && <span>· corrected {pct(l.priceCheckAtLogging.correctedChance)}</span>}
          {l.finalScore && <span>· FT {l.finalScore}</span>}
          <ResultBadge result={l.result} />
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={{ background: '#0a0d15', border: '1px solid #1e2535', borderRadius: 8, padding: '11px 13px' }}>
      <div style={{ fontSize: 9, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.7px' }}>{label}</div>
      <div style={{ fontSize: 21, color: '#e2e8f0', fontWeight: 800, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function SportyRecord({ predictions, summary }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 14 }}>
        <Metric label="Matches recorded" value={summary?.matchesRecorded ?? 0} />
        <Metric label="Market calls scored" value={summary?.settledCalls ?? 0} />
        <Metric label="Correct" value={summary?.won ?? 0} />
        <Metric label="Hit rate" value={summary?.hitRate == null ? 'Pending' : `${summary.hitRate}%`} />
      </div>

      {predictions.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
          No prediction ledger entries yet. New Agent47 morning predictions will appear here automatically.
        </div>
      ) : predictions.map((p) => (
        <div key={p.predictionId} style={{
          border: '1px solid #1e2535', borderRadius: 8, marginBottom: 9,
          background: '#0a0d15', overflow: 'hidden',
        }}>
          <div style={{ padding: '9px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid #131826' }}>
            <strong style={{ fontSize: 12, color: '#e2e8f0' }}>{p.home} vs {p.away}</strong>
            <span style={{ fontSize: 10, color: '#64748b' }}>{p.league}</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: p.finalScore ? '#cbd5e1' : '#64748b', fontWeight: 700 }}>
              {p.finalScore ? `FT ${p.finalScore}` : 'Awaiting result'}
            </span>
          </div>
          <div style={{ padding: '8px 12px' }}>
            {(p.markets || []).map((m, i) => (
              <div key={`${m.marketKey}-${i}`} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 0', borderBottom: i < (p.markets || []).length - 1 ? '1px solid #131826' : 'none',
              }}>
                <span style={{ flex: 1, fontSize: 11, color: '#cbd5e1', fontWeight: 700 }}>{m.selection}</span>
                <span style={{ fontSize: 10, color: '#8b9ab3' }}>{pct(m.modelProbability ?? m.confidence)}</span>
                <ResultBadge result={m.result} />
              </div>
            ))}
          </div>
          <div style={{ padding: '0 12px 9px', fontSize: 9, color: '#475569' }}>
            Predicted {p.predictedAt ? new Date(p.predictedAt).toLocaleString('en-GB') : 'time unavailable'}
            {p.analysisVersion ? ` · ${p.analysisVersion}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

function MyBets({ bets }) {
  const played = useMemo(
    () => (bets || []).filter((b) => b?.source === 'USER_PLAYED'),
    [bets]
  );
  const real = played.filter((b) => b.paper !== true);
  const realProfit = real.map(betProfit).filter((v) => v != null);
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 14 }}>
        <Metric label="Bets played" value={played.length} />
        <Metric label="Won" value={played.filter((b) => b.result === 'won').length} />
        <Metric label="Lost" value={played.filter((b) => b.result === 'lost').length} />
        <Metric label="Real profit/loss" value={realProfit.length ? naira(realProfit.reduce((a, v) => a + v, 0)) : '—'} />
        <Metric label="Practice bets" value={played.length - real.length} />
      </div>
      <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10 }}>
        Profit/loss counts real-money selections with a recorded stake and SportyBet odds. Practice bets and older records without a stake are listed but not counted.
      </div>

      {played.length === 0 ? (
        <div style={{ padding: 30, textAlign: 'center', color: '#64748b', fontSize: 12 }}>
          Nothing marked as played yet. Use I PLAYED THIS beside the exact Agent47 recommendation you chose.
        </div>
      ) : played.map((b) => (
        <div key={b.firestoreId || b.id} style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '10px 12px', border: '1px solid #1e2535', borderRadius: 8,
          background: '#0a0d15', marginBottom: 8,
        }}>
          {b.slipType === 'double' && Array.isArray(b.legs) ? (
            <div style={{ minWidth: 170, flex: 1 }}>
              <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 700 }}>
                <span style={{ fontSize: 9, fontWeight: 800, color: '#a78bfa', border: '1px solid #7c3aed55', borderRadius: 4, padding: '1px 5px', marginRight: 6 }}>DOUBLE</span>
                Combined odds {Number(b.odds).toFixed(2)}
                {Number(b.effectiveOdds) > 1 && Number(b.effectiveOdds) !== Number(b.odds) && <span style={{ fontSize: 10, color: '#fbbf24' }}> · paid as a single at {Number(b.effectiveOdds).toFixed(2)} (one leg void)</span>}
              </div>
              <DoubleLegs legs={b.legs} />
              {b.needsReview && <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 3 }}>{b.reviewNote || 'Check this slip on SportyBet.'}</div>}
            </div>
          ) : (
            <>
              <div style={{ minWidth: 170, flex: 1 }}>
                <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 700 }}>{b.home} vs {b.away}</div>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{b.selection}</div>
              </div>
              <span style={{ fontSize: 10, color: '#8b9ab3' }}>
                {pct(b.modelProbability ?? b.confidence)}
                {b.priceCheckAtLogging?.correctedChance != null && <small style={{ display: 'block' }}>Corrected {pct(b.priceCheckAtLogging.correctedChance)}</small>}
                {b.priceCheckAtLogging?.minimumOdds != null && <small style={{ display: 'block' }}>Min odds then {b.priceCheckAtLogging.minimumOdds.toFixed(2)}</small>}
              </span>
            </>
          )}
          {b.paper === true && <span style={{ fontSize: 9, fontWeight: 800, color: '#fbbf24', border: '1px solid #78350f55', borderRadius: 4, padding: '1px 5px' }}>PRACTICE</span>}
          <span style={{ fontSize: 10, color: '#8b9ab3' }}>
            {Number(b.stake) > 0 ? `Stake ₦${Number(b.stake).toLocaleString('en-GB')}` : 'Stake not recorded'}
            {betProfit(b) != null && <small style={{ display: 'block', color: betProfit(b) >= 0 ? '#00b859' : '#ef4444' }}>P/L {naira(betProfit(b))}</small>}
          </span>
          {b.slipType !== 'double' && <span style={{ fontSize: 10, color: '#8b9ab3' }}>
            System odds: {b.systemOdds?.price ? `${b.systemOdds.price.toFixed(2)} · ${b.systemOdds.bookmaker?.name}` : 'Unavailable'}
            {b.systemOdds?.providerUpdatedAt && <small style={{ display: 'block' }}>Quote: {new Date(b.systemOdds.providerUpdatedAt).toLocaleString()}{b.systemOdds.status === 'EXPIRED' ? ' · expired when recorded' : ''}</small>}
            {b.odds > 1 && <small style={{ display: 'block' }}>{b.bookmaker || 'SportyBet'} odds taken: {Number(b.odds).toFixed(2)}</small>}
          </span>}
          {b.finalScore && <span style={{ fontSize: 10, color: '#8b9ab3' }}>FT {b.finalScore}</span>}
          <ResultBadge result={b.result} />
        </div>
      ))}
    </div>
  );
}

export default function PerformanceHub({ bets: liveBets = [] }) {
  const [tab, setTab] = useState('sporty');
  const [predictions, setPredictions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [bets, setBets] = useState(liveBets);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState('');
  async function checkResults() {
    setChecking(true); setCheckMessage('Checking fixture results…');
    try {
      const response = await apiService.client.post('/bets/settle', {}, { timeout: 120000 });
      const updated = await apiService.getBets();
      setBets(updated.data?.bets || []);
      setCheckMessage(`${response.data.settled} selections settled; ${response.data.checked} fixtures checked.${response.data.failed ? ' Some checks will retry.' : ''}`);
    } catch (error) { setCheckMessage(error.response?.data?.error || 'Result check could not complete. Please retry.'); }
    finally { setChecking(false); }
  }

  useEffect(() => {
    setBets(liveBets);
  }, [liveBets]);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiService.getPredictions(250).catch(() => ({ data: { predictions: [], summary: null } })),
      apiService.getBets().catch(() => ({ data: { bets: [] } })),
    ]).then(([predRes, betRes]) => {
      if (!active) return;
      setPredictions(predRes?.data?.predictions || []);
      setSummary(predRes?.data?.summary || null);
      setBets(betRes?.data?.bets || liveBets || []);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px 35px', background: '#0f1117' }}>
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 18, color: '#e2e8f0', fontWeight: 800 }}>Track Record</div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
            SportyRabbi's predictions and your actual selections are kept separate. This screen shows the latest 250 prediction records; the permanent ledger remains stored.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid #1e2535' }}>
          {[
            ['sporty', 'SportyRabbi Record'],
            ['mine', 'My Bets'],
          ].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: tab === id ? '#00b859' : '#8b9ab3',
              borderBottom: tab === id ? '2px solid #00b859' : '2px solid transparent',
              padding: '9px 12px', fontSize: 12, fontWeight: tab === id ? 800 : 600,
            }}>{label}</button>
          ))}
        </div>

        {tab === 'mine' && <div style={{ marginBottom: 12 }}>
          <button disabled={checking} onClick={checkResults} style={{ padding: '8px 12px', background: '#001f0e', color: '#b8f5d2', border: '1px solid #006833', borderRadius: 6 }}>{checking ? 'Checking…' : 'Check results'}</button>
          <span role="status" style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginTop: 6 }}>{checkMessage}</span>
        </div>}
        {loading ? (
          <div style={{ color: '#64748b', fontSize: 12, padding: 20 }}>Loading track record...</div>
        ) : tab === 'sporty'
          ? <SportyRecord predictions={predictions} summary={summary || {}} />
          : <MyBets bets={bets} />
        }
      </div>
    </div>
  );
}
