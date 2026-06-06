import React, { useState, useEffect } from 'react';
import { apiService } from '../services/api';

// Constants
const TIER_COLORS = { 1: '#f59e0b', 2: '#00e676', 3: '#fbbf24', 4: '#f97316' };
const TIER_BG     = { 1: '#1c1200', 2: '#001a0d', 3: '#1c1200', 4: '#1a0c00' };
const TIER_BORDER = { 1: '#78350f', 2: '#065f46', 3: '#78350f', 4: '#7c2d12' };

const PARAMS = [
  { key: 'p4_form',           label: 'Team Form (L10)',   weight: '14%', icon: 'FRM' },
  { key: 'p1_motivation',     label: 'Motivation Gap',    weight: '13%', icon: 'MOT' },
  { key: 'p15_crisis',        label: 'Crisis/Drought',    weight: '12%', icon: 'CRS' },
  { key: 'p7_poisson',        label: 'Poisson Model',     weight: '11%', icon: 'PSN' },
  { key: 'p2_starPower',      label: 'Star Power',        weight: '7%',  icon: 'STR' },
  { key: 'p6_defensiveGap',   label: 'Defensive Gap',     weight: '7%',  icon: 'DEF' },
  { key: 'p8_xg',             label: 'xG Attack',         weight: '6%',  icon: 'XGA' },
  { key: 'p5_scoringTiming',  label: 'Scoring Timing',    weight: '5%',  icon: 'TIM' },
  { key: 'p9_xga',            label: 'xGA Defence',       weight: '5%',  icon: 'XGD' },
  { key: 'p13_squad',         label: 'Squad Integrity',   weight: '5%',  icon: 'SQD' },
  { key: 'p10_pace',          label: 'Pace & Conversion', weight: '4%',  icon: 'PAC' },
  { key: 'p3_h2h',            label: 'H2H History',       weight: '3%',  icon: 'H2H' },
  { key: 'p11_homeAdvantage', label: 'Home Advantage',    weight: '3%',  icon: 'HOM' },
  { key: 'p12_market',        label: 'Market Signal',     weight: '3%',  icon: 'MKT' },
  { key: 'p14_lifecycle',     label: 'League Lifecycle',  weight: '2%',  icon: 'LFC' },
];

function scoreColor(s) {
  return s >= 70 ? '#00e676' : s >= 55 ? '#fbbf24' : '#ef4444';
}

function edgeBadge(edge) {
  if (!edge || edge === 'NEUTRAL') return null;
  const c = edge === 'HOME' ? '#3b82f6' : '#a78bfa';
  return (
    <span style={{ background: c + '22', border: `1px solid ${c}55`, borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 700, color: c, marginLeft: 6 }}>
      {edge}
    </span>
  );
}

function ScoreBar({ score }) {
  if (score == null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <div style={{ flex: 1, background: '#080c14', borderRadius: 3, height: 4, border: '1px solid #1a2540' }} />
        <span style={{ fontSize: 11, color: '#64748b', minWidth: 70, textAlign: 'right' }}>Unavailable</span>
      </div>
    );
  }
  const c = scoreColor(score);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
      <div style={{ flex: 1, background: '#080c14', borderRadius: 3, height: 4, border: '1px solid #1a2540', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(score, 100)}%`, height: '100%', background: `linear-gradient(90deg,${c}55,${c})`, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color: c, minWidth: 28, textAlign: 'right' }}>{Math.round(score)}</span>
    </div>
  );
}

function ProbBar({ label, value, highlight }) {
  const c = highlight ? '#00e676' : '#3b82f6';
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: '#64748b' }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: c }}>{value}%</span>
      </div>
      <div style={{ background: '#080c14', borderRadius: 3, height: 3, border: '1px solid #1a2540', overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: `linear-gradient(90deg,${c}44,${c})` }} />
      </div>
    </div>
  );
}

export default function AnalyticsModal({ match, onClose }) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [section, setSection]   = useState('params'); // 'params' | 'poisson' | 'chaos' | 'edges'

  useEffect(() => { runAnalysis(); }, [match]);

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    try {
      const matchData = {
        home:             match.home,
        away:             match.away,
        league:           match.league || 'Unknown',
        leagueId:         match.leagueId || 0,
        status:           (match.isLive || ['1H','2H','HT','ET','BT','P'].includes(match.status)) ? 'LIVE' : (match.status || 'NS'),
        matchMinutes:     match.matchMinutes || 0,
        score:            match.score    || '0-0',
        homePossession:   match.possession?.home > 0 ? match.possession.home : null,
        homeXgAvg:        match.xg?.home  > 0 ? match.xg.home : null,
        awayXgAvg:        match.xg?.away  > 0 ? match.xg.away : null,
        homeXgaAvg:       match.xg?.away  > 0 ? match.xg.away : null,
        awayXgaAvg:       match.xg?.home  > 0 ? match.xg.home : null,
        homeShotsPerGame: match.shots?.home > 0 ? match.shots.home : null,
        awayShotsPerGame: match.shots?.away > 0 ? match.shots.away : null,
      };
      const res = await apiService.client.post('/analyze', matchData);
      setAnalysis(res.data);
    } catch (err) {
      console.error('V8 analysis error:', err);
      setError(err.response?.data?.error || err.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  const overlay  = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999, padding: '16px' };
  const modal    = { background: '#0d1421', border: '1px solid #1a2540', borderRadius: 12, maxWidth: 760, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' };

  if (loading) return (
    <div style={overlay}>
      <div style={{ ...modal, alignItems: 'center', justifyContent: 'center', padding: 60 }}>
        <div style={{ width: 36, height: 36, border: '3px solid #1a2540', borderTopColor: '#00e676', borderRadius: '50%', animation: 'spin 0.8s linear infinite', marginBottom: 16 }} />
        <p style={{ color: '#475569', fontSize: 13 }}>Running V8 analysis...</p>
      </div>
    </div>
  );

  if (error) return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...modal, padding: 40, textAlign: 'center' }}>
        <p style={{ color: '#ef4444', fontSize: 14, marginBottom: 8 }}>Warning: {error}</p>
        <p style={{ color: '#475569', fontSize: 12 }}>Backend may be offline. Check Railway deployment.</p>
      </div>
    </div>
  );

  const { parameters: P = {}, poisson, chaos, recommendations = [], bookieEdges = [], overallScore = 0, tier = 4, tierName = '', winCall } = analysis || {};
  const probs = poisson?.probabilities || {};

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modal}>
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #1a2540', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0' }}>{match.home} <span style={{ color: '#1e293b' }}>vs</span> {match.away}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: '#334155' }}>{match.league}</span>
              <span style={{ background: '#001a0d', border: '1px solid #065f46', borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 800, color: '#00e676', letterSpacing: '0.5px' }}>V9</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: TIER_COLORS[tier] }}>T{tier} - {tierName}</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: scoreColor(overallScore) }}>{overallScore}%</span>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                color: winCall?.outcome === 'UNDECIDED' ? '#fbbf24' : '#94a3b8',
                background: winCall?.outcome === 'UNDECIDED' ? '#1c1200' : '#111c30',
                border: `1px solid ${winCall?.outcome === 'UNDECIDED' ? '#78350f' : '#1a2540'}`,
                borderRadius: 4,
                padding: '1px 6px',
              }}>
                {winCall?.selection || 'Wins (Undecided)'}
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: 22, lineHeight: 1 }}>x</button>
        </div>

        {/* Top Recommendations */}
        {recommendations.length > 0 && (
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #1a2540', display: 'flex', gap: 10, overflowX: 'auto', flexShrink: 0 }}>
            {recommendations.slice(0, 4).map((r, i) => (
              <div key={i} style={{ background: TIER_BG[r.tier], border: `1px solid ${TIER_BORDER[r.tier]}`, borderRadius: 8, padding: '8px 14px', flexShrink: 0, minWidth: 140 }}>
                <div style={{ fontSize: 10, color: TIER_COLORS[r.tier], fontWeight: 800, marginBottom: 3 }}>TIER {r.tier} - {r.confidence}%</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{r.selection}</div>
                <div style={{ fontSize: 10, color: '#475569', marginTop: 4, lineHeight: 1.4 }}>{r.logic.slice(0, 60)}...</div>
              </div>
            ))}
          </div>
        )}

        {/* Section tabs */}
        <div style={{ padding: '0 20px', borderBottom: '1px solid #1a2540', display: 'flex', gap: 0, flexShrink: 0 }}>
          {[['params','15 Parameters'],['poisson','Poisson'],['chaos','Chaos'],['edges','Edge Detect']].map(([k,l]) => (
            <button key={k} onClick={() => setSection(k)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '10px 16px', fontSize: 12, fontWeight: section === k ? 700 : 500, color: section === k ? '#00e676' : '#475569', borderBottom: section === k ? '2px solid #00e676' : '2px solid transparent', transition: 'color 0.15s' }}>
              {l}
            </button>
          ))}
        </div>

        {/* Scrollable content */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px' }}>

          {/* 15 PARAMETERS */}
          {section === 'params' && (
            <div>
              {PARAMS.map(({ key, label, weight, icon }) => {
                const p = P[key] || {};
                return (
                  <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: '1px solid #111c30' }}>
                    <div style={{ width: 30, textAlign: 'center', fontSize: 16, flexShrink: 0, paddingTop: 2 }}>{icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1' }}>{label}</span>
                        <span style={{ fontSize: 10, color: '#1e293b', background: '#111c30', borderRadius: 4, padding: '1px 5px' }}>{weight}</span>
                        {edgeBadge(p.edge)}
                        {p.crisisLevel && <span style={{ fontSize: 10, fontWeight: 700, color: p.crisisLevel === 'STABLE' ? '#00e676' : p.crisisLevel === 'STRESSED' ? '#fbbf24' : '#ef4444', marginLeft: 4 }}>[{p.crisisLevel}]</span>}
                        {p.phase && <span style={{ fontSize: 10, color: '#64748b', marginLeft: 4 }}>{p.phase}</span>}
                      </div>
                      <ScoreBar score={p.score ?? null} />
                      {p.assessment && <p style={{ fontSize: 11, color: '#475569', marginTop: 5, lineHeight: 1.5 }}>{p.assessment}</p>}
                      {p.flags?.length > 0 && p.flags.map((f, i) => (
                        <p key={i} style={{ fontSize: 11, color: '#fbbf24', marginTop: 3 }}>{f}</p>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* POISSON */}
          {section === 'poisson' && (
            <div>
              {!poisson || poisson.insufficientData ? (
                <div style={{ padding: '32px 0', textAlign: 'center' }}>
                  <p style={{ fontSize: 13, color: '#64748b', marginBottom: 8 }}>Poisson view unavailable for this fixture.</p>
                  <p style={{ fontSize: 11, color: '#475569' }}>Model inputs are incomplete right now. Stats refresh should restore this section.</p>
                </div>
              ) : (<>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                <div style={{ background: '#080c14', border: '1px solid #1a2540', borderRadius: 8, padding: '12px 16px' }}>
                  <div style={{ fontSize: 10, color: '#334155', marginBottom: 4 }}>EXPECTED GOALS</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#00e676' }}>{poisson.expectedTotalGoals ?? 'Unavailable'}</div>
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>H:{poisson.homeLambda ?? 'Unavailable'} - A:{poisson.awayLambda ?? 'Unavailable'}</div>
                </div>
                <div style={{ background: '#080c14', border: '1px solid #1a2540', borderRadius: 8, padding: '12px 16px' }}>
                  <div style={{ fontSize: 10, color: '#334155', marginBottom: 4 }}>LIKELY SCORE</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#3b82f6' }}>{poisson.likelyScore?.score || 'Unavailable'}</div>
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>
                    {poisson.likelyScore?.probability != null ? `${poisson.likelyScore.probability}% probability` : 'Unavailable'}
                  </div>
                </div>
              </div>
              <div style={{ background: '#080c14', border: '1px solid #1a2540', borderRadius: 8, padding: '16px' }}>
                <ProbBar label="Over 0.5 Goals" value={probs.over05 ?? 0}  highlight />
                <ProbBar label="Over 1.5 Goals" value={probs.over15 ?? 0}  highlight />
                <ProbBar label="Over 2.5 Goals" value={probs.over25 ?? 0}  highlight={probs.over25 >= 60} />
                <ProbBar label="Over 3.5 Goals" value={probs.over35 ?? 0}  highlight={false} />
                <ProbBar label="Under 2.5 Goals" value={probs.under25 ?? 0} highlight={probs.under25 >= 60} />
                <ProbBar label="BTTS"            value={probs.btts ?? 0}   highlight={probs.btts >= 60} />
              </div>
              <p style={{ fontSize: 12, color: '#475569', marginTop: 14, lineHeight: 1.6 }}>{poisson.assessment}</p>
              </>)}
            </div>
          )}

          {/* CHAOS */}
          {section === 'chaos' && chaos && (
            <div>
              <div style={{ background: '#080c14', border: '1px solid #1a2540', borderRadius: 8, padding: '16px', marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                  <ChaosFlag label="MWV Index"    value={chaos.mwvLabel}          active={chaos.mwvIndex > 0.5} />
                  <ChaosFlag label="Early Goal"   value={chaos.earlyGoalActive ? 'ACTIVE' : 'NO'} active={chaos.earlyGoalActive} />
                  <ChaosFlag label="Bivariate"    value={chaos.bivariateDependency ? 'YES' : 'NO'} active={chaos.bivariateDependency} />
                  <ChaosFlag label="PSG Trap"     value={chaos.psgTrapWarning ? 'YES' : 'NO'} active={chaos.psgTrapWarning} />
                  <ChaosFlag label="High Line"    value={chaos.highLineRisk ? 'YES' : 'NO'} active={chaos.highLineRisk} />
                </div>
              </div>
              {chaos.summary && chaos.summary.split('\n').filter(Boolean).map((line, i) => (
                <div key={i} style={{ background: '#0d1421', border: '1px solid #1a2540', borderRadius: 6, padding: '10px 14px', marginBottom: 8, fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>{line}</div>
              ))}
            </div>
          )}

          {/* BOOKIE EDGES */}
          {section === 'edges' && (
            <div>
              {bookieEdges.length === 0 && <p style={{ color: '#334155', fontSize: 13, padding: '20px 0' }}>No bookie edges detected for this fixture.</p>}
              {bookieEdges.map((e, i) => (
                <div key={i} style={{ background: '#120d00', border: '1px solid #78350f', borderRadius: 8, padding: '12px 16px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ fontSize: 16 }}>$</span>
                    <p style={{ fontSize: 12, color: '#d97706', lineHeight: 1.6 }}>{e}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ChaosFlag({ label, value, active }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: '#334155', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 800, color: active ? '#fbbf24' : '#1e293b' }}>{value}</div>
    </div>
  );
