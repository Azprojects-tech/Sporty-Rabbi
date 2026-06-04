import React, { useState, useEffect } from 'react';
import { apiService } from '../services/api';
import { getLeagueStatDefaults } from '../../../shared/leagueDefaults.js';

const TIER_COLORS = { 1: '#f59e0b', 2: '#00b859', 3: '#fbbf24', 4: '#f97316' };
const TIER_BG     = { 1: '#1c1200', 2: '#001f0e', 3: '#1c1200', 4: '#1a0c00' };
const TIER_BORDER = { 1: '#78350f55', 2: '#00683355', 3: '#78350f55', 4: '#7c2d1255' };

const PARAMS = [
  { key: 'p4_form',           label: 'Form (L10)',   weight: '15%', icon: 'FRM' },
  { key: 'p1_motivation',     label: 'Motivation',   weight: '13%', icon: 'MOT' },
  { key: 'p7_poisson',        label: 'Poisson',      weight: '11%', icon: 'PSN' },
  { key: 'p15_crisis',        label: 'Crisis',       weight: '10%', icon: 'CRS' },
  { key: 'p2_starPower',      label: 'Star Power',   weight: '7%',  icon: 'STR' },
  { key: 'p6_defensiveGap',   label: 'Defensive',    weight: '7%',  icon: 'DEF' },
  { key: 'p8_xg',             label: 'xG Edge',      weight: '6%',  icon: 'XGA' },
  { key: 'p5_scoringTiming',  label: 'Timing',       weight: '5%',  icon: 'TIM' },
  { key: 'p9_xga',            label: 'Def. Solidity',weight: '5%',  icon: 'XGD' },
  { key: 'p13_squad',         label: 'Comp. Context',weight: '5%',  icon: 'CTX' },
  { key: 'p10_pace',          label: 'Pace',         weight: '4%',  icon: 'PAC' },
  { key: 'p12_market',        label: 'Mkt. Diverge.',weight: '4%',  icon: 'MKT' },
  { key: 'p11_homeAdvantage', label: 'Home Adv.',    weight: '3%',  icon: 'HOM' },
  { key: 'p3_h2h',            label: 'H2H',          weight: '3%',  icon: 'H2H' },
  { key: 'p14_lifecycle',     label: 'Lifecycle',    weight: '2%',  icon: 'LFC' },
];

function scoreColor(s) {
  return s >= 70 ? '#00b859' : s >= 55 ? '#fbbf24' : '#ef4444';
}

function ScoreBar({ score }) {
  if (score == null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
        <div style={{ flex: 1, background: '#0a0d15', borderRadius: 3, height: 3 }} />
        <span style={{ fontSize: 11, fontWeight: 500, color: '#374151', minWidth: 24, textAlign: 'right' }}>--</span>
      </div>
    );
  }
  const c = scoreColor(score);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
      <div style={{ flex: 1, background: '#0a0d15', borderRadius: 3, height: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(score, 100)}%`, height: '100%', background: c }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color: c, minWidth: 24, textAlign: 'right' }}>
        {Math.round(score)}
      </span>
    </div>
  );
}

function edgeBadge(edge) {
  if (!edge || edge === 'NEUTRAL') return null;
  const c = edge === 'HOME' ? '#3b82f6' : '#a78bfa';
  return (
    <span style={{
      background: c + '22', border: `1px solid ${c}55`, borderRadius: 3,
      padding: '1px 5px', fontSize: 9, fontWeight: 700, color: c, marginLeft: 5,
    }}>
      {edge}
    </span>
  );
}

function FormBadges({ formStr }) {
  if (!formStr) return <span style={{ fontSize: 11, color: '#4a5568' }}>No data</span>;
  const results = String(formStr).toUpperCase().split(/[-,\s]+/).filter(Boolean).slice(0, 10);
  const colors = { W: '#00b859', D: '#fbbf24', L: '#ef4444' };
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
      {results.map((r, i) => (
        <span key={i} style={{
          width: 22, height: 22, borderRadius: '50%', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: (colors[r] || '#4a5568') + '22',
          border: `1px solid ${colors[r] || '#4a5568'}55`,
          fontSize: 10, fontWeight: 800, color: colors[r] || '#4a5568',
        }}>{r}</span>
      ))}
    </div>
  );
}

function DataSnapshot({ analysis, match }) {
  const homeOpp = analysis?.dataContext?.homeRecentOpposition;
  const awayOpp = analysis?.dataContext?.awayRecentOpposition;
  const hasLiveStats = match?.possession || match?.shots || match?.xg;

  if (!homeOpp && !awayOpp && !hasLiveStats) return null;

  return (
    <div style={{
      padding: '11px 14px',
      borderBottom: '1px solid #1e2535',
      background: '#0d1421',
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: '#8b9ab3', letterSpacing: '1px', marginBottom: 8 }}>
        DATA SNAPSHOT
      </div>
      {hasLiveStats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
          <div style={{ background: '#0f1117', border: '1px solid #1e2535', borderRadius: 6, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: '#4a5568' }}>Possession</div>
            <div style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 700 }}>{match?.possession?.home ?? '-'}% / {match?.possession?.away ?? '-' }%</div>
          </div>
          <div style={{ background: '#0f1117', border: '1px solid #1e2535', borderRadius: 6, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: '#4a5568' }}>Shots</div>
            <div style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 700 }}>{match?.shots?.home ?? '-'} / {match?.shots?.away ?? '-'}</div>
          </div>
          <div style={{ background: '#0f1117', border: '1px solid #1e2535', borderRadius: 6, padding: '8px 10px' }}>
            <div style={{ fontSize: 9, color: '#4a5568' }}>xG</div>
            <div style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 700 }}>{match?.xg?.home ?? '-'} / {match?.xg?.away ?? '-'}</div>
          </div>
        </div>
      )}
      {homeOpp?.summary && (
        <p style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.6, margin: '0 0 6px 0' }}>
          <strong style={{ color: '#e2e8f0' }}>{match?.home}:</strong> {homeOpp.summary}
        </p>
      )}
      {awayOpp?.summary && (
        <p style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.6, margin: 0 }}>
          <strong style={{ color: '#e2e8f0' }}>{match?.away}:</strong> {awayOpp.summary}
        </p>
      )}
    </div>
  );
}

function ParamDetail({ paramKey, p, match }) {
  const assessment = Array.isArray(p.assessment)
    ? p.assessment.filter(Boolean).join('. ')
    : (p.assessment || '');

  if (paramKey === 'p4_form') {
    const homeFormStr = p.home?.formStr || p.homeForm || '';
    const awayFormStr = p.away?.formStr  || p.awayForm  || '';
    return (
      <div style={{ paddingTop: 8, paddingBottom: 4, paddingLeft: 4, borderTop: '1px solid #1e253522' }}>
        <div style={{ fontSize: 11, color: '#8b9ab3', marginBottom: 6, fontWeight: 600 }}>
          Last 10 results (newest to oldest):
        </div>
        <div style={{ fontSize: 11, color: '#4a5568', marginBottom: 3 }}>{match?.home || 'Home'}</div>
        <FormBadges formStr={homeFormStr} />
        <div style={{ fontSize: 11, color: '#4a5568', marginTop: 8, marginBottom: 3 }}>{match?.away || 'Away'}</div>
        <FormBadges formStr={awayFormStr} />
        {assessment ? (
          <p style={{ fontSize: 11, color: '#4a5568', marginTop: 8, lineHeight: 1.6 }}>{assessment}</p>
        ) : null}
      </div>
    );
  }

  if (paramKey === 'p3_h2h') {
    const hw = p.homeWins ?? p.home?.wins;
    const aw = p.awayWins ?? p.away?.wins;
    const d  = p.draws;
    const goalsAvg = p.goalsAvg;
    const overRate = p.overRate != null ? Math.round(p.overRate * 100) : null;
    return (
      <div style={{ paddingTop: 8, paddingLeft: 4, borderTop: '1px solid #1e253522' }}>
        {(hw != null || aw != null) && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
            {[
              { label: match?.home || 'Home', val: hw,       color: '#3b82f6' },
              { label: 'Draws',               val: d,        color: '#fbbf24' },
              { label: match?.away || 'Away', val: aw,       color: '#a78bfa' },
            ].map(({ label, val, color }) => val != null ? (
              <div key={label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 800, color }}>{val}</div>
                <div style={{ fontSize: 9, color: '#4a5568' }}>{label}</div>
              </div>
            ) : null)}
            {goalsAvg != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#00b859' }}>{Number(goalsAvg).toFixed(1)}</div>
                <div style={{ fontSize: 9, color: '#4a5568' }}>Avg Goals</div>
              </div>
            )}
            {overRate != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#fbbf24' }}>{overRate}%</div>
                <div style={{ fontSize: 9, color: '#4a5568' }}>Over 2.5</div>
              </div>
            )}
          </div>
        )}
        {assessment ? <p style={{ fontSize: 11, color: '#4a5568', lineHeight: 1.6 }}>{assessment}</p> : null}
      </div>
    );
  }

  return assessment ? (
    <div style={{ paddingTop: 8, paddingLeft: 4, borderTop: '1px solid #1e253522' }}>
      <p style={{ fontSize: 11, color: '#4a5568', lineHeight: 1.7, margin: 0 }}>{assessment}</p>
    </div>
  ) : null;
}

export default function DetailPanel({ match, analysis: preloadedAnalysis, onClose }) {
  const [analysis, setAnalysis]     = useState(preloadedAnalysis || null);
  // Only show full-screen spinner if there is nothing to display yet
  const [loading, setLoading]       = useState(!preloadedAnalysis);
  const [error, setError]           = useState(null);
  const [section, setSection]       = useState('params');
  const [expandedParam, setExpandedParam] = useState(null);

  useEffect(() => {
    // Always run fresh analysis on click — calibrated or not
    // If we already have preloaded data it stays visible while the refresh runs in background
    loadAnalysis();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.id]);

  // Auto-refresh every 30s when the match is live
  useEffect(() => {
    const isLive = match?.isLive || ['1H','2H','HT','ET','BT','P'].includes(match?.status);
    if (!isLive) return;
    const iv = setInterval(loadAnalysis, 30000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match?.id, match?.status, match?.isLive]);

  async function loadAnalysis() {
    // Show spinner only when there is no existing analysis to display
    if (!analysis && !preloadedAnalysis) setLoading(true);
    setError(null);
    try {
      const _lid = match.leagueId || 0;
      const leagueDefaults = getLeagueStatDefaults(_lid);
      const matchData = {
        home:             match.home,
        away:             match.away,
        league:           match.league || 'Unknown',
        leagueId:         _lid,
        homeTeamId:       match.homeTeamId || null,
        awayTeamId:       match.awayTeamId || null,
        status:           (match.isLive || ['1H','2H','HT','ET','BT','P'].includes(match.status)) ? 'LIVE' : (match.status || 'NS'),
        matchMinutes:     match.matchMinutes || 0,
        score:            match.score    || '0-0',
        homePossession:   match.possession?.home || 50,
        hasLiveXg:        !!(match.xg?.home > 0 || match.xg?.away > 0),
        homeXgAvg:        match.xg?.home  > 0 ? match.xg.home  : leagueDefaults.homeXgAvg,
        awayXgAvg:        match.xg?.away  > 0 ? match.xg.away  : leagueDefaults.awayXgAvg,
        homeXgaAvg:       match.xg?.away  > 0 ? match.xg.away  : leagueDefaults.awayXgAvg,
        awayXgaAvg:       match.xg?.home  > 0 ? match.xg.home  : leagueDefaults.homeXgAvg,
        homeShotsPerGame: match.shots?.home > 0 ? match.shots.home : leagueDefaults.homeShotsPerGame,
        awayShotsPerGame: match.shots?.away > 0 ? match.shots.away : leagueDefaults.awayShotsPerGame,
        matchType:        match.matchType || 'League',
        homeCards: { yellow: match.cards?.home?.yellow || 0, red: match.cards?.home?.red || 0 },
        awayCards: { yellow: match.cards?.away?.yellow || 0, red: match.cards?.away?.red || 0 },
      };
      const res = await apiService.client.post('/analyze', matchData);
      setAnalysis(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }

  const panelStyle = {
    width: 370, flexShrink: 0,
    background: '#0a0d15',
    borderLeft: '1px solid #1e2535',
    height: '100vh',
    maxHeight: '100vh',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  };

  if (loading) return (
    <div style={panelStyle}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <div style={{ width: 28, height: 28, border: '2px solid #1e2535', borderTopColor: '#00b859', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <p style={{ fontSize: 12, color: '#4a5568' }}>Running V9 analysis...</p>
      </div>
    </div>
  );

  if (error) return (
    <div style={panelStyle}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #1e2535', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#8b9ab3' }}>V8 Analysis</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5568', fontSize: 20 }}>x</button>
      </div>
      <div style={{ padding: 20 }}>
        <p style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>! {error}</p>
        <button onClick={loadAnalysis} style={{ background: '#001f0e', border: '1px solid #006833', borderRadius: 6, padding: '8px 16px', color: '#00b859', fontSize: 12, cursor: 'pointer', fontWeight: 700 }}>Retry</button>
      </div>
    </div>
  );

  const {
    parameters: P = {}, poisson, chaos,
    recommendations = [], bookieEdges = [],
    overallScore = 0, tier = 4, tierName = '',
  } = analysis || {};
  const winCall = analysis?.winCall || null;
  const probs = poisson?.probabilities || {};

  const topPicks = recommendations
    .map(r => ({
      ...r,
      selection: typeof r.selection === 'object'
        ? (r.selection?.label || r.selection?.name || JSON.stringify(r.selection))
        : String(r.selection || ''),
    }));

  return (
    <div style={panelStyle}>
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>

      {/* Header */}
      <div style={{ padding: '13px 16px', borderBottom: '1px solid #1e2535', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {match.home} <span style={{ color: '#4a5568', fontWeight: 400 }}>vs</span> {match.away}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 9, background: '#001f0e', border: '1px solid #006833', borderRadius: 3, padding: '1px 5px', fontWeight: 800, color: '#00b859', letterSpacing: '0.5px' }}>
                V9
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: TIER_COLORS[tier] }}>
                T{tier} &middot; {tierName}
              </span>
              <span style={{ fontSize: 14, fontWeight: 800, color: scoreColor(overallScore) }}>
                {overallScore}%
              </span>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                color: winCall?.outcome === 'UNDECIDED' ? '#fbbf24' : '#8b9ab3',
                background: winCall?.outcome === 'UNDECIDED' ? '#1c1200' : '#0f1117',
                border: `1px solid ${winCall?.outcome === 'UNDECIDED' ? '#78350f55' : '#1e2535'}`,
                borderRadius: 4,
                padding: '2px 6px',
              }}>
                {winCall?.selection || 'Wins (Undecided)'}
              </span>
              {analysis?.gemini && (
                <span style={{ fontSize: 9, color: '#4a5568' }}>
                  AI {analysis.gemini.confidence}% confident
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5568', fontSize: 22, lineHeight: 1, padding: '0 0 0 8px', flexShrink: 0 }}>
            &times;
          </button>
        </div>
      </div>

      {/* Agent Recommendation */}
      {topPicks.length > 0 && (
        <div style={{
          padding: '12px 14px',
          borderBottom: '1px solid #1e2535',
          flexShrink: 0,
          background: '#001a0a',
        }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: '#00b859', letterSpacing: '1px', marginBottom: 8 }}>
            AGENT RECOMMENDATION
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {topPicks.map((r, i) => (
              <div key={i} style={{
                background: TIER_BG[r.tier],
                border: `1px solid ${TIER_BORDER[r.tier]}`,
                borderRadius: 8,
                padding: '10px 13px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 800, color: TIER_COLORS[r.tier],
                    background: TIER_COLORS[r.tier] + '22',
                    border: `1px solid ${TIER_COLORS[r.tier]}44`,
                    borderRadius: 3, padding: '2px 6px', letterSpacing: '0.5px',
                  }}>
                    TIER {r.tier}
                  </span>
                  <span style={{ fontSize: 9, color: '#4a5568' }}>&middot;</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: scoreColor(r.confidence) }}>
                    {r.confidence}% confidence
                  </span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#e2e8f0', marginBottom: 5, lineHeight: 1.3 }}>
                  &rsaquo; {r.selection}
                </div>
                {r.logic && (
                  <div style={{ fontSize: 11, color: '#6b7d96', lineHeight: 1.5 }}>
                    {r.logic.length > 100 ? r.logic.slice(0, 100) + '...' : r.logic}
                  </div>
                )}
                {r.evidence && (
                  <div style={{ marginTop: 7, paddingTop: 7, borderTop: '1px solid #1e253555' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 5 }}>
                      <span style={{ fontSize: 9, color: '#8b9ab3', background: '#0f1117', border: '1px solid #1e2535', borderRadius: 3, padding: '1px 5px' }}>
                        {r.evidence.competitionFamily}
                      </span>
                      <span style={{ fontSize: 9, color: '#8b9ab3', background: '#0f1117', border: '1px solid #1e2535', borderRadius: 3, padding: '1px 5px' }}>
                        EG {r.evidence.poisson?.expectedGoals ?? '--'}
                      </span>
                      <span style={{ fontSize: 9, color: '#8b9ab3', background: '#0f1117', border: '1px solid #1e2535', borderRadius: 3, padding: '1px 5px' }}>
                        O2.5 {r.evidence.poisson?.over25 ?? '--'}%
                      </span>
                    </div>
                    {Array.isArray(r.evidence.topFactors) && r.evidence.topFactors.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {r.evidence.topFactors.slice(0, 3).map((f, fi) => (
                          <span key={fi} style={{ fontSize: 9, color: '#94a3b8', background: '#0a0d15', border: '1px solid #1e2535', borderRadius: 3, padding: '1px 5px' }}>
                            {f.label} {f.score}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Groq narrative — LLM analyst note layered on top of V9 output */}
      {analysis?.narrative?.text && (
        <div style={{
          padding: '11px 14px',
          borderBottom: '1px solid #1e2535',
          flexShrink: 0,
          background: '#05101f',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
            <span style={{ fontSize: 9, fontWeight: 800, color: '#3b82f6', letterSpacing: '1px' }}>ANALYST NOTE</span>
            <span style={{ fontSize: 9, color: '#4a5568' }}>· AI</span>
            {analysis.narrative.confidence && (
              <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: scoreColor(analysis.narrative.confidence) }}>
                {analysis.narrative.confidence}% assurance
              </span>
            )}
          </div>
          <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.65, margin: 0 }}>
            {analysis.narrative.text}
          </p>
        </div>
      )}

      <DataSnapshot analysis={analysis} match={match} />

      {/* Section tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #1e2535' }}>
        {[['params', 'Parameters'], ['poisson', 'Poisson'], ['chaos', 'Chaos'], ['edges', 'Edges']].map(([k, l]) => (
          <button key={k} onClick={() => setSection(k)} style={{
            flex: 1, background: 'none', border: 'none', cursor: 'pointer',
            padding: '9px 4px', fontSize: 11, fontWeight: section === k ? 700 : 500,
            color: section === k ? '#00b859' : '#4a5568',
            borderBottom: section === k ? '2px solid #00b859' : '2px solid transparent',
          }}>
            {l}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: '10px 14px 28px' }}>

        {/* PARAMETERS */}
        {section === 'params' && (
          <div>
            <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 8 }}>
              Tap a parameter to see detail
            </div>
            {PARAMS.map(({ key, label, weight, icon }) => {
              const p = P[key] || {};
              const isExpanded = expandedParam === key;
              const hasDetail = !!(
                p.assessment || p.home?.formStr || p.away?.formStr ||
                p.homeForm || p.awayForm || p.goalsAvg != null || p.homeWins != null
              );
              return (
                <div
                  key={key}
                  onClick={() => hasDetail && setExpandedParam(isExpanded ? null : key)}
                  style={{
                    borderBottom: '1px solid #0f1117',
                    cursor: hasDetail ? 'pointer' : 'default',
                    borderRadius: isExpanded ? 6 : 0,
                    background: isExpanded ? '#0f1117' : 'transparent',
                    padding: isExpanded ? '8px 8px 10px' : '8px 0',
                    marginBottom: isExpanded ? 4 : 0,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, color: '#4a5568',
                      width: 28, flexShrink: 0, textAlign: 'center',
                      background: '#0f1117', borderRadius: 3, padding: '2px 0',
                    }}>{icon}</span>
                    <div style={{ width: 84, flexShrink: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: isExpanded ? '#e2e8f0' : '#8b9ab3', display: 'flex', alignItems: 'center' }}>
                        {label}
                        {edgeBadge(p.edge)}
                      </div>
                      <div style={{ fontSize: 9, color: '#4a5568' }}>{weight}</div>
                    </div>
                    <ScoreBar score={p.score ?? null} />
                    {hasDetail && (
                      <span style={{ fontSize: 10, color: '#4a5568', flexShrink: 0, marginLeft: 4 }}>
                        {isExpanded ? '[^]' : '[v]'}
                      </span>
                    )}
                  </div>
                  {isExpanded && (
                    <ParamDetail paramKey={key} p={p} match={match} />
                  )}
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
                <p style={{ fontSize: 13, color: '#4a5568', marginBottom: 8 }}>Poisson view unavailable for this fixture.</p>
                <p style={{ fontSize: 11, color: '#374151' }}>Model inputs are incomplete right now. Stats refresh should restore this section.</p>
              </div>
            ) : (<>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
              <div style={{ background: '#0f1117', border: '1px solid #1e2535', borderRadius: 7, padding: '12px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, color: '#4a5568', marginBottom: 5, letterSpacing: '0.5px' }}>EXPECTED GOALS</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#00b859' }}>{poisson.expectedTotalGoals ?? '--'}</div>
                <div style={{ fontSize: 10, color: '#4a5568', marginTop: 3 }}>H:{poisson.homeLambda ?? '--'} &middot; A:{poisson.awayLambda ?? '--'}</div>
              </div>
              <div style={{ background: '#0f1117', border: '1px solid #1e2535', borderRadius: 7, padding: '12px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, color: '#4a5568', marginBottom: 5, letterSpacing: '0.5px' }}>
                  {poisson.liveProjectedFinalScore ? 'PROJECTED FINAL' : 'LIKELY SCORE'}
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#3b82f6' }}>
                  {poisson.liveProjectedFinalScore
                    ? poisson.liveProjectedFinalScore.score
                    : (poisson.likelyScore?.score || '--')}
                </div>
                <div style={{ fontSize: 10, color: '#4a5568', marginTop: 3 }}>
                  {poisson.liveProjectedFinalScore
                    ? `${poisson.liveProjectedFinalScore.probAnotherGoal}% P(+goal)`
                    : `${poisson.likelyScore?.probability ?? '--'}%`}
                </div>
              </div>
            </div>
            {[
              { label: 'Over 0.5',  val: probs.over05,  hi: true },
              { label: 'Over 1.5',  val: probs.over15,  hi: true },
              { label: 'Over 2.5',  val: probs.over25,  hi: probs.over25 >= 60 },
              { label: 'Over 3.5',  val: probs.over35,  hi: false },
              { label: 'Under 2.5', val: probs.under25, hi: probs.under25 >= 60 },
              { label: 'BTTS',      val: probs.btts,    hi: probs.btts >= 60 },
            ].map(({ label, val, hi }) => (
              <div key={label} style={{ marginBottom: 9 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 11, color: '#8b9ab3' }}>{label}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: hi ? '#00b859' : '#8b9ab3' }}>{val ?? '--'}{val != null ? '%' : ''}</span>
                </div>
                <div style={{ background: '#0f1117', borderRadius: 2, height: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${val ?? 0}%`, height: '100%', background: hi ? '#00b859' : '#1e2535' }} />
                </div>
              </div>
            ))}
            {poisson.assessment && (
              <p style={{ fontSize: 11, color: '#4a5568', marginTop: 12, lineHeight: 1.6 }}>{poisson.assessment}</p>
            )}
            </>)}
          </div>
        )}

        {/* CHAOS */}
        {section === 'chaos' && chaos && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { label: 'MWV Index',  val: chaos.mwvLabel,                           active: chaos.mwvIndex > 0.5 },
              { label: 'Early Goal', val: chaos.earlyGoalActive ? 'ACTIVE' : 'NO',  active: chaos.earlyGoalActive },
              { label: 'Bivariate',  val: chaos.bivariateDependency ? 'YES' : 'NO', active: chaos.bivariateDependency },
              { label: 'PSG Trap',   val: chaos.psgTrapWarning ? 'WARNING' : 'CLEAR', active: chaos.psgTrapWarning },
              { label: 'High Line',  val: chaos.highLineRisk ? 'ACTIVE' : 'NO',     active: chaos.highLineRisk },
            ].map(({ label, val, active }) => (
              <div key={label} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '10px 14px', background: '#0f1117', borderRadius: 7,
                border: '1px solid #1e2535',
              }}>
                <span style={{ fontSize: 12, color: '#8b9ab3' }}>{label}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: active ? '#fbbf24' : '#4a5568' }}>{val}</span>
              </div>
            ))}
            {chaos.summary && (
              <p style={{ fontSize: 11, color: '#4a5568', marginTop: 4, lineHeight: 1.6 }}>{chaos.summary}</p>
            )}
          </div>
        )}

        {/* EDGES */}
        {section === 'edges' && (
          <div>
            {bookieEdges.length === 0 ? (
              <p style={{ fontSize: 12, color: '#4a5568', textAlign: 'center', padding: '24px 0' }}>
                No value edges detected for this fixture.
              </p>
            ) : bookieEdges.map((e, i) => (
              <div key={i} style={{
                background: '#120d00', border: '1px solid #78350f44',
                borderRadius: 7, padding: '10px 14px', marginBottom: 8,
                fontSize: 11, color: '#d97706', lineHeight: 1.6,
              }}>
                $ {e}
              </div>
            ))}
          </div>
        )}

      </div>
      </div>
    </div>
  );
}
