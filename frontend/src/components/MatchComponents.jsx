import React from 'react';

const CONF_COLOR = s => s >= 70 ? '#00e676' : s >= 60 ? '#fbbf24' : '#ef4444';

export function MatchCard({ match, onSelectMatch }) {
  const isLive = match.status === 'LIVE';
  const conf   = match.confidence || 0;
  const [hs, as_] = (match.score || '0-0').split('-').map(Number);

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

      {/* Row 3: stats pills + confidence bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <StatPill label="Poss"  value={`${match.possession?.home || 0}–${match.possession?.away || 0}%`} />
        <StatPill label="Shots" value={`${match.shots?.home || 0}–${match.shots?.away || 0}`} />
        <StatPill label="xG"    value={`${(match.xg?.home || 0).toFixed(1)}–${(match.xg?.away || 0).toFixed(1)}`} />
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


export function MatchCard({ match, onSelectMatch }) {
  return (
    <div className="card-hover cursor-pointer group">
      <div className="flex justify-between items-start mb-4 gap-2">
        <span className="text-xs sm:text-sm font-bold text-green-400 bg-green-900 px-2 py-1 rounded">
          {match.status || 'LIVE'}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelectMatch(match);
          }}
          className="text-xs sm:text-sm font-bold text-purple-400 bg-purple-900/40 hover:bg-purple-900 border border-purple-500 px-2 sm:px-3 py-1.5 rounded transition min-h-[36px] flex items-center"
        >
          📊 Stats
        </button>
      </div>

      {/* Score - Larger on mobile */}
      <div className="text-center mb-4">
        <div className="flex justify-between items-center">
          <div className="flex-1">
            <p className="font-bold text-sm sm:text-base">{match.home}</p>
            <p className="text-3xl sm:text-4xl font-bold text-green-400">{match.score?.split('-')[0] || 0}</p>
          </div>
          <div className="mx-2 sm:mx-4 text-gray-500 font-bold">vs</div>
          <div className="flex-1 text-right">
            <p className="font-bold text-sm sm:text-base">{match.away}</p>
            <p className="text-3xl sm:text-4xl font-bold text-green-400">{match.score?.split('-')[1] || 0}</p>
          </div>
        </div>
      </div>

      {/* Stats - Better mobile spacing */}
      <div className="grid grid-cols-3 gap-2 text-xs mb-4 border-t border-gray-700 pt-4">
        <div className="bg-gray-900/50 rounded p-2">
          <p className="text-gray-400 text-xs">Possession</p>
          <p className="font-bold text-sm">{match.possession?.home || 0}%</p>
        </div>
        <div className="bg-gray-900/50 rounded p-2">
          <p className="text-gray-400 text-xs">Shots</p>
          <p className="font-bold text-sm">
            {match.shots?.home || 0} vs {match.shots?.away || 0}
          </p>
        </div>
        <div className="bg-gray-900/50 rounded p-2">
          <p className="text-gray-400 text-xs">xG</p>
          <p className="font-bold text-sm">
            {(match.xg?.home || 0).toFixed(1)} vs {(match.xg?.away || 0).toFixed(1)}
          </p>
        </div>
      </div>

      {/* Confidence */}
      <ConfidenceScore score={match.confidence} />
    </div>
  );
}

export function ConfidenceScore({ score }) {
  let color = 'text-red-400';
  if (score >= 70) color = 'text-green-400';
  else if (score >= 60) color = 'text-yellow-400';

  return (
    <div className="flex items-center gap-2">
      <div className="w-full bg-gray-700 rounded-full h-2">
        <div
          className={`h-2 rounded-full ${
            score >= 70 ? 'bg-green-500' : score >= 60 ? 'bg-yellow-500' : 'bg-red-500'
          }`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className={`${color} font-bold text-sm`}>{score.toFixed(0)}%</span>
    </div>
  );
}

export function Alert({ match, alert }) {
  return (
    <div className="bg-gradient-to-r from-yellow-900 to-orange-900 border border-yellow-600 rounded-lg p-4 mb-3">
      <div className="flex gap-3">
        <AlertCircle className="text-yellow-400 flex-shrink-0 mt-1" size={20} />
        <div className="flex-1">
          <h4 className="font-bold text-yellow-300 mb-1">{alert.title}</h4>
          <p className="text-sm text-gray-200 mb-2">{alert.description}</p>
          <div className="flex justify-between items-center">
            <ConfidenceScore score={alert.confidence_score} />
            <button className="btn btn-primary btn-sm">
              💡 {alert.recommended_bet}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
