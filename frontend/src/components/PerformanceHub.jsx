import React, { useEffect, useMemo, useState } from 'react';
import { apiService } from '../services/api';

function ResultBadge({ result }) {
  const r = String(result || 'pending').toLowerCase();
  const won = r === 'won';
  const lost = r === 'lost';
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
      {won ? 'CORRECT' : lost ? 'WRONG' : 'PENDING'}
    </span>
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
                <span style={{ fontSize: 10, color: '#8b9ab3' }}>{m.modelProbability ?? m.confidence ?? '—'}%</span>
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
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 14 }}>
        <Metric label="Selections played" value={played.length} />
        <Metric label="Won" value={played.filter((b) => b.result === 'won').length} />
        <Metric label="Lost" value={played.filter((b) => b.result === 'lost').length} />
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
          <div style={{ minWidth: 170, flex: 1 }}>
            <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 700 }}>{b.home} vs {b.away}</div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{b.selection}</div>
          </div>
          <span style={{ fontSize: 10, color: '#8b9ab3' }}>{b.modelProbability ?? b.confidence ?? '—'}%</span>
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
            SportyRabbi's predictions and your actual selections are kept separate.
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
