import React, { memo } from 'react';

const CONF_COLOR = s => s >= 70 ? '#00e676' : s >= 60 ? '#fbbf24' : '#ef4444';

const LIVE_STATUSES = new Set(['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P']);

export function MatchCard({ match, onSelectMatch }) {
  const isLive = LIVE_STATUSES.has(match.status);
  const conf   = match.confidence || 0;
  const [hs, as_] = (match.score || '0-0').split('-').map(Number);
  const hasPossession = Number(match.possession?.home) > 0 && Number(match.possession?.away) > 0;
  const hasShots = Number(match.shots?.home) > 0 && Number(match.shots?.away) > 0;
  const hasXg = Number(match.xg?.home) > 0 && Number(match.xg?.away) > 0;

  return (
    <div
      onClick={onSelectMatch}
      style={{
        background: '#0d1421',
        border: `1px solid ${isLive ? '#3f1515' : '#1a2540'}`,
        borderLeft: `3px solid ${isLive ? '#ef4444' : '#1a2540'}`,
        borderRadius: 10,
        padding: '13px 18px',
        cursor: 'pointer',
        transition: 'background 0.15s, border-color 0.15s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = '#111c30'}
      onMouseLeave={e => e.currentTarget.style.background = '#0d1421'}
    >
      {/* Row 1: status + league + confidence + analyze */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isLive ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#200808', border: '1px solid #7f1d1d', borderRadius: 5, padding: '2px 8px' }}>
              <span className="live-dot" />
              <span style={{ color: '#ef4444', fontSize: 11, fontWeight: 800, letterSpacing: '0.5px' }}>{match.matchMinutes || 0}'</span>
            </span>
          ) : (
            <span style={{ background: '#0a1628', border: '1px solid #1e3a5f', borderRadius: 5, padding: '2px 8px', color: '#60a5fa', fontSize: 11, fontWeight: 700 }}>
              NS
            </span>
          )}
          <span style={{ color: '#334155', fontSize: 11, fontWeight: 600 }}>{match.league || ''}</span>
          {match.round && (
            <span style={{ background: '#1a2540', border: '1px solid #2d4a8a', borderRadius: 5, padding: '2px 7px', color: '#93c5fd', fontSize: 10, fontWeight: 700 }}>
              {match.round}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: CONF_COLOR(conf) }}>
            A47 {conf}%
          </span>
          <button
            onClick={e => { e.stopPropagation(); onSelectMatch(); }}
            style={{
              background: '#0a1628', border: '1px solid #1e3a5f', borderRadius: 6,
              padding: '4px 11px', color: '#60a5fa', fontSize: 10,
              fontWeight: 800, cursor: 'pointer', letterSpacing: '0.8px',
            }}
          >
            ANALYZE
          </button>
        </div>
      </div>

      {/* Row 2: teams + score */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {match.home}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#080c14', borderRadius: 8, border: '1px solid #1a2540', padding: '5px 14px', flexShrink: 0 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: isLive ? '#00e676' : '#475569', minWidth: 16, textAlign: 'center' }}>{hs}</span>
          <span style={{ color: '#1e293b', fontSize: 13, fontWeight: 700 }}>:</span>
          <span style={{ fontSize: 20, fontWeight: 800, color: isLive ? '#00e676' : '#475569', minWidth: 16, textAlign: 'center' }}>{as_}</span>
        </div>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>
          {match.away}
        </span>
      </div>

      {/* Knockout notes — e.g. "2nd Leg - Nottingham lead 1-0 on aggregate" */}
      {match.notes && (
        <div style={{ fontSize: 10, color: '#6b7fa3', fontStyle: 'italic', marginBottom: 8, marginTop: -4, paddingLeft: 2 }}>
          {match.notes}
        </div>
      )}

      {/* Prediction strip — always visible on every card */}
      {(() => {
        const recs = match.analysis?.recommendations || [];
        const winRec = recs.find(r => r.type === 'WINS_ONLY' && (r.confidence || 0) >= 55);
        const predictedWinner = winRec ? winRec.selection : 'UNDECIDED';
        const predictedScore  = match.analysis?.poisson?.likelyScore?.score || 'Unavailable';
        const isHome   = winRec && winRec.selection === `${match.home} Win`;
        const winColor = !winRec ? '#334155' : isHome ? '#60a5fa' : '#c084fc';
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            margin: '6px 0 8px', background: '#080c14', border: '1px solid #1a2540',
            borderRadius: 6, padding: '5px 10px', gap: 6 }}>
            <span style={{ fontSize: 9, color: '#334155', fontWeight: 700,
              letterSpacing: '0.5px', textTransform: 'uppercase', flexShrink: 0 }}>Predicted</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: winColor, flex: 1,
              textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', padding: '0 4px' }}>
              {predictedWinner}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#475569',
              flexShrink: 0, letterSpacing: '1px' }}>
              {predictedScore}
            </span>
          </div>
        );
      })()}

      {/* Row 3: stats pills + confidence bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <StatPill label="Poss"  value={hasPossession ? `${match.possession.home}-${match.possession.away}%` : 'Unavailable'} />
        <StatPill label="Shots" value={hasShots ? `${match.shots.home}-${match.shots.away}` : 'Unavailable'} />
        <StatPill label="xG"    value={hasXg ? `${Number(match.xg.home).toFixed(1)}-${Number(match.xg.away).toFixed(1)}` : 'Unavailable'} />
        <div style={{ flex: 1, minWidth: 80 }}>
          <ConfBar score={conf} />
        </div>
      </div>
    </div>
  );
}

function StatPill({ label, value }) {
  return (
    <div style={{ background: '#080c14', border: '1px solid #1a2540', borderRadius: 5, padding: '3px 9px', fontSize: 11, flexShrink: 0 }}>
      <span style={{ color: '#334155', marginRight: 4 }}>{label}</span>
      <span style={{ color: '#64748b', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function ConfBar({ score }) {
  const c = CONF_COLOR(score);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, background: '#080c14', borderRadius: 3, height: 3, border: '1px solid #1a2540' }}>
        <div style={{ width: `${score}%`, height: '100%', borderRadius: 3, background: `linear-gradient(90deg, ${c}44, ${c})` }} />
      </div>
    </div>
  );
}

// Keep exports used by other parts of the app
export function ConfidenceScore({ score }) {
  const c = CONF_COLOR(score);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, background: '#080c14', borderRadius: 3, height: 4, border: '1px solid #1a2540', overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: `linear-gradient(90deg, ${c}55, ${c})` }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color: c, minWidth: 32 }}>{Math.round(score)}%</span>
    </div>
  );
}

export function Alert({ alert }) {
  return (
    <div style={{ background: '#120d00', border: '1px solid #78350f', borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <span style={{ fontSize: 18 }}>⚠️</span>
        <div>
          <p style={{ fontWeight: 700, color: '#fbbf24', marginBottom: 5, fontSize: 13 }}>{alert.title}</p>
          <p style={{ fontSize: 12, color: '#94a3b8' }}>{alert.description}</p>
        </div>
      </div>
    </div>
  );
}
