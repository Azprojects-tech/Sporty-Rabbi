import React, { useState, useEffect } from 'react';
import { apiService } from '../services/api';

// ─── Constants ────────────────────────────────────────────────────────────────
const TIER_COLORS = { 1: '#f59e0b', 2: '#00e676', 3: '#fbbf24', 4: '#f97316' };
const TIER_BG     = { 1: '#1c1200', 2: '#001a0d', 3: '#1c1200', 4: '#1a0c00' };
const TIER_BORDER = { 1: '#78350f', 2: '#065f46', 3: '#78350f', 4: '#7c2d12' };

const PARAMS = [
  { key: 'p1_motivation',  label: 'Motivation Gap',    weight: '16%', icon: '🔥' },
  { key: 'p4_form',        label: 'Team Form (L10)',   weight: '12%', icon: '📈' },
  { key: 'p7_poisson',     label: 'Poisson Model',     weight: '9%',  icon: '🧮' },
  { key: 'p3_h2h',         label: 'H2H History',       weight: '8%',  icon: '⚔️'  },
  { key: 'p2_starPower',   label: 'Star Power',        weight: '7%',  icon: '⭐' },
  { key: 'p5_timing',      label: 'Scoring Timing',    weight: '7%',  icon: '⏱️'  },
  { key: 'p6_defensive',   label: 'Defensive Gap',     weight: '7%',  icon: '🛡️'  },
  { key: 'p8_xg',          label: 'xG Attack',         weight: '6%',  icon: '🎯' },
  { key: 'p15_crisis',     label: 'Crisis/Drought',    weight: '10%', icon: '🚨' },
  { key: 'p9_xga',         label: 'xGA Defence',       weight: '5%',  icon: '🧱' },
  { key: 'p13_squad',      label: 'Squad Integrity',   weight: '5%',  icon: '💪' },
  { key: 'p10_pace',       label: 'Pace & Conversion', weight: '4%',  icon: '⚡' },
  { key: 'p11_timezone',   label: 'Timezone/Referee',  weight: '2%',  icon: '🏁' },
  { key: 'p14_lifecycle',  label: 'League Lifecycle',  weight: '1%',  icon: '📅' },
  { key: 'p12_fixture',    label: 'Fixture Lock',       weight: '1%',  icon: '📌' },
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
        status:           match.status  || 'NS',
        matchMinutes:     match.matchMinutes || 0,
        score:            match.score    || '0-0',
        homePossession:   match.possession?.home || 50,
        homeXgAvg:        match.xg?.home  || 1.3,
        awayXgAvg:        match.xg?.away  || 1.1,
        homeXgaAvg:       match.xg?.away  || 1.2,
        awayXgaAvg:       match.xg?.home  || 1.2,
        homeShotsPerGame: match.shots?.home || 12,
        awayShotsPerGame: match.shots?.away || 10,
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
        <p style={{ color: '#475569', fontSize: 13 }}>Running V8 analysis…</p>
      </div>
    </div>
  );

  if (error) return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...modal, padding: 40, textAlign: 'center' }}>
        <p style={{ color: '#ef4444', fontSize: 14, marginBottom: 8 }}>⚠️ {error}</p>
        <p style={{ color: '#475569', fontSize: 12 }}>Backend may be offline. Check Railway deployment.</p>
      </div>
    </div>
  );

  const { parameters: P = {}, poisson, chaos, recommendations = [], bookieEdges = [], overallScore = 0, tier = 4, tierName = '' } = analysis || {};
  const probs = poisson?.probabilities || {};

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={modal}>
        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #1a2540', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0' }}>{match.home} <span style={{ color: '#1e293b' }}>vs</span> {match.away}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: '#334155' }}>{match.league}</span>
              <span style={{ background: '#001a0d', border: '1px solid #065f46', borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 800, color: '#00e676', letterSpacing: '0.5px' }}>V8-MASTER</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: TIER_COLORS[tier] }}>T{tier} · {tierName}</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: scoreColor(overallScore) }}>{overallScore}%</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        {/* ── Top Recommendations ─────────────────────────────── */}
        {recommendations.length > 0 && (
          <div style={{ padding: '12px 20px', borderBottom: '1px solid #1a2540', display: 'flex', gap: 10, overflowX: 'auto', flexShrink: 0 }}>
            {recommendations.slice(0, 4).map((r, i) => (
              <div key={i} style={{ background: TIER_BG[r.tier], border: `1px solid ${TIER_BORDER[r.tier]}`, borderRadius: 8, padding: '8px 14px', flexShrink: 0, minWidth: 140 }}>
                <div style={{ fontSize: 10, color: TIER_COLORS[r.tier], fontWeight: 800, marginBottom: 3 }}>TIER {r.tier} · {r.confidence}%</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{r.selection}</div>
                <div style={{ fontSize: 10, color: '#475569', marginTop: 4, lineHeight: 1.4 }}>{r.logic.slice(0, 60)}…</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Section tabs ────────────────────────────────────── */}
        <div style={{ padding: '0 20px', borderBottom: '1px solid #1a2540', display: 'flex', gap: 0, flexShrink: 0 }}>
          {[['params','15 Parameters'],['poisson','Poisson'],['chaos','Chaos'],['edges','Edge Detect']].map(([k,l]) => (
            <button key={k} onClick={() => setSection(k)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '10px 16px', fontSize: 12, fontWeight: section === k ? 700 : 500, color: section === k ? '#00e676' : '#475569', borderBottom: section === k ? '2px solid #00e676' : '2px solid transparent', transition: 'color 0.15s' }}>
              {l}
            </button>
          ))}
        </div>

        {/* ── Scrollable content ──────────────────────────────── */}
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
                      <ScoreBar score={p.score || 0} />
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
          {section === 'poisson' && poisson && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                <div style={{ background: '#080c14', border: '1px solid #1a2540', borderRadius: 8, padding: '12px 16px' }}>
                  <div style={{ fontSize: 10, color: '#334155', marginBottom: 4 }}>EXPECTED GOALS</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#00e676' }}>{poisson.expectedTotalGoals}</div>
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>H:{poisson.homeLambda} · A:{poisson.awayLambda}</div>
                </div>
                <div style={{ background: '#080c14', border: '1px solid #1a2540', borderRadius: 8, padding: '12px 16px' }}>
                  <div style={{ fontSize: 10, color: '#334155', marginBottom: 4 }}>LIKELY SCORE</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#3b82f6' }}>{poisson.likelyScore?.score || '—'}</div>
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>{poisson.likelyScore?.probability}% probability</div>
                </div>
              </div>
              <div style={{ background: '#080c14', border: '1px solid #1a2540', borderRadius: 8, padding: '16px' }}>
                <ProbBar label="Over 0.5 Goals" value={probs.over05}  highlight />
                <ProbBar label="Over 1.5 Goals" value={probs.over15}  highlight />
                <ProbBar label="Over 2.5 Goals" value={probs.over25}  highlight={probs.over25 >= 60} />
                <ProbBar label="Over 3.5 Goals" value={probs.over35}  highlight={false} />
                <ProbBar label="Under 2.5 Goals" value={probs.under25} highlight={probs.under25 >= 60} />
                <ProbBar label="BTTS"            value={probs.btts}   highlight={probs.btts >= 60} />
              </div>
              <p style={{ fontSize: 12, color: '#475569', marginTop: 14, lineHeight: 1.6 }}>{poisson.assessment}</p>
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
                    <span style={{ fontSize: 16 }}>💰</span>
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
}

export default function AnalyticsModal({ match, onClose }) {
  const [activeTab, setActiveTab] = useState('home');
  const [homeForm, setHomeForm] = useState(null);
  const [awayForm, setAwayForm] = useState(null);
  const [h2h, setH2H] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadAnalytics();
  }, [match]);

  const loadAnalytics = async () => {
    setLoading(true);
    setError(null);
    try {
      // We need team IDs, which should be in match data
      // If not available, we'll show a message
      if (!match.homeTeamId || !match.awayTeamId) {
        console.warn('Team IDs not available in match data');
        // Try using the names as fallback or show error
        setError('Team ID data not yet available. Please refresh.');
        setLoading(false);
        return;
      }

      const [homeData, awayData, h2hData] = await Promise.all([
        apiService.client.get(`/analytics/team-form/${match.homeTeamId}`).catch(e => {
          console.error('Home form error:', e);
          return { data: { success: false } };
        }),
        apiService.client.get(`/analytics/team-form/${match.awayTeamId}`).catch(e => {
          console.error('Away form error:', e);
          return { data: { success: false } };
        }),
        apiService.client.get(`/analytics/h2h/${match.homeTeamId}/${match.awayTeamId}`).catch(e => {
          console.error('H2H error:', e);
          return { data: { success: false } };
        }),
      ]);

      if (homeData.data?.success) setHomeForm(homeData.data.data);
      if (awayData.data?.success) setAwayForm(awayData.data.data);
      if (h2hData.data?.success) setH2H(h2hData.data.data);

      if (!homeData.data?.success && !awayData.data?.success && !h2hData.data?.success) {
        setError('Could not load team statistics. API data may not be available yet.');
      }
    } catch (err) {
      console.error('Analytics error:', err);
      setError('Could not load team statistics');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-gray-900 rounded-lg p-6 text-center">
          <div className="animate-spin h-8 w-8 border-4 border-purple-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-gray-300">Loading team statistics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto border border-purple-500/30">
        {/* Header */}
        <div className="sticky top-0 bg-gray-900 border-b border-purple-500/30 p-4 flex justify-between items-center">
          <h2 className="text-xl font-bold text-white">
            {match.home} vs {match.away} - Analytics
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 text-2xl font-bold"
          >
            ×
          </button>
        </div>

        {error && (
          <div className="p-4 bg-yellow-500/20 border-b border-yellow-500/30 text-yellow-300">
            ⚠️ {error}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-purple-500/20 bg-gray-800/50">
          <button
            onClick={() => setActiveTab('home')}
            className={`flex-1 px-4 py-3 font-semibold transition ${
              activeTab === 'home'
                ? 'text-purple-400 border-b-2 border-purple-500'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            {match.home} Form
          </button>
          <button
            onClick={() => setActiveTab('away')}
            className={`flex-1 px-4 py-3 font-semibold transition ${
              activeTab === 'away'
                ? 'text-purple-400 border-b-2 border-purple-500'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            {match.away} Form
          </button>
          <button
            onClick={() => setActiveTab('h2h')}
            className={`flex-1 px-4 py-3 font-semibold transition ${
              activeTab === 'h2h'
                ? 'text-purple-400 border-b-2 border-purple-500'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            H2H History
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {activeTab === 'home' && homeForm ? <TeamStats team={homeForm} /> : activeTab === 'home' && <div className="text-gray-400">No data available</div>}
          {activeTab === 'away' && awayForm ? <TeamStats team={awayForm} /> : activeTab === 'away' && <div className="text-gray-400">No data available</div>}
          {activeTab === 'h2h' && h2h ? <H2HStats h2h={h2h} /> : activeTab === 'h2h' && <div className="text-gray-400">No head-to-head data available</div>}
        </div>
      </div>
    </div>
  );
}

function TeamStats({ team }) {
  if (team?.error) {
    return <p className="text-gray-400">Could not load team data</p>;
  }

  const stats = team?.stats || {};
  const matches = team?.matches || [];

  return (
    <div className="space-y-6">
      {/* Stats Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-green-500/10 border border-green-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Wins</p>
          <p className="text-2xl font-bold text-green-400">{stats.wins || 0}</p>
        </div>
        <div className="bg-gray-500/10 border border-gray-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Draws</p>
          <p className="text-2xl font-bold text-gray-300">{stats.draws || 0}</p>
        </div>
        <div className="bg-red-500/10 border border-red-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Losses</p>
          <p className="text-2xl font-bold text-red-400">{stats.losses || 0}</p>
        </div>
        <div className="bg-blue-500/10 border border-blue-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Win Rate</p>
          <p className="text-2xl font-bold text-blue-400">{stats.winRate || '0'}%</p>
        </div>
      </div>

      {/* Goal Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-purple-500/10 border border-purple-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Goals For (Avg)</p>
          <p className="text-2xl font-bold text-purple-300">
            {stats.goalsFor} ({(stats.avgGoalsFor || 0).toFixed(1)})
          </p>
        </div>
        <div className="bg-red-500/10 border border-red-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Goals Against (Avg)</p>
          <p className="text-2xl font-bold text-red-300">
            {stats.goalsAgainst} ({(stats.avgGoalsAgainst || 0).toFixed(1)})
          </p>
        </div>
      </div>

      {/* Form String */}
      {stats.form && (
        <div>
          <p className="text-gray-400 text-sm mb-2">Recent Form (Last 10)</p>
          <div className="flex gap-2">
            {stats.form.split('').map((result, idx) => (
              <div
                key={idx}
                className={`w-8 h-8 flex items-center justify-center rounded font-bold text-white ${
                  result === 'W'
                    ? 'bg-green-600'
                    : result === 'D'
                    ? 'bg-gray-600'
                    : 'bg-red-600'
                }`}
              >
                {result}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function H2HStats({ h2h }) {
  if (h2h.stats?.error) {
    return <p className="text-gray-400">Could not load H2H data</p>;
  }

  const stats = h2h.stats || {};
  const matches = h2h.matches || [];

  return (
    <div className="space-y-6">
      {/* H2H Record */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-blue-500/10 border border-blue-500/30 rounded p-4 text-center">
          <p className="text-gray-400 text-sm">{h2h.teamAName || 'Team A'} Wins</p>
          <p className="text-3xl font-bold text-blue-400">{stats.teamAWins || 0}</p>
        </div>
        <div className="bg-gray-500/10 border border-gray-500/30 rounded p-4 text-center">
          <p className="text-gray-400 text-sm">Draws</p>
          <p className="text-3xl font-bold text-gray-300">{stats.draws || 0}</p>
        </div>
        <div className="bg-orange-500/10 border border-orange-500/30 rounded p-4 text-center">
          <p className="text-gray-400 text-sm">{h2h.teamBName || 'Team B'} Wins</p>
          <p className="text-3xl font-bold text-orange-400">{stats.teamBWins || 0}</p>
        </div>
      </div>

      {/* Goal Stats */}
      <div className="bg-purple-500/10 border border-purple-500/30 rounded p-4">
        <p className="text-gray-400 text-sm mb-2">Total Goals</p>
        <p className="text-2xl font-bold text-purple-300 mb-1">
          {stats.totalGoals || 0} goals in {matches.length} meetings
        </p>
        <p className="text-gray-400 text-sm">
          Average: {stats.avgGoalsPerMatch || 0} goals per match
        </p>
      </div>

      {/* Previous Matches */}
      {matches.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-800">
              <tr>
                <th className="px-4 py-2 text-left text-gray-400">Date</th>
                <th className="px-4 py-2 text-left text-gray-400">Home</th>
                <th className="px-4 py-2 text-center text-gray-400">Score</th>
                <th className="px-4 py-2 text-left text-gray-400">Away</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((match, i) => (
                <tr key={i} className="border-t border-gray-700 hover:bg-gray-800/50">
                  <td className="px-4 py-2 text-gray-400 text-xs">
                    {new Date(match.date).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-white">{match.home}</td>
                  <td className="px-4 py-2 text-center font-bold text-purple-300">
                    {match.homeGoals} - {match.awayGoals}
                  </td>
                  <td className="px-4 py-2 text-white">{match.away}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
