import React from 'react';

const LEAGUE_FLAGS = {
  39: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 140: '🇪🇸', 78: '🇩🇪', 135: '🇮🇹', 61: '🇫🇷',
  88: '🇳🇱', 64: '🇵🇹', 203: '🇹🇷', 541: '🇸🇦',
  1: '⭐', 3: '🟠', 849: '💜',
  4: '🏆', 18: '🎯', 2: '🇪🇺', 5: '🌎', 6: '🌍',
  16: '🏅', 17: '🎖️', 15: '🤝',
  98: '🇯🇵', 292: '🇰🇷', 188: '🇦🇺', 253: '🇺🇸',
  71: '🇧🇷', 128: '🇦🇷', 239: '🇨🇴',
};

function ConfBadge({ score }) {
  if (score >= 80) return (
    <span style={{
      background: '#1c1200', border: '1px solid #78350f', borderRadius: 4,
      padding: '2px 8px', fontSize: 10, fontWeight: 800, color: '#f59e0b',
      flexShrink: 0,
    }}>
      {score}% 🔥
    </span>
  );
  if (score >= 70) return (
    <span style={{
      background: '#001f0e', border: '1px solid #006833', borderRadius: 4,
      padding: '2px 8px', fontSize: 10, fontWeight: 700, color: '#00b859',
      flexShrink: 0,
    }}>
      {score}%
    </span>
  );
  return (
    <span style={{ fontSize: 10, color: '#4a5568', minWidth: 34, flexShrink: 0, textAlign: 'right' }}>
      {score}%
    </span>
  );
}

function StatusCell({ status, minute, kickoffUTC }) {
  const isLive = status === 'LIVE' || status === '1H' || status === '2H' || status === 'HT';
  if (isLive) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: 56, flexShrink: 0 }}>
        <span className="live-dot" />
        <span style={{ fontSize: 11, fontWeight: 700, color: '#ef4444' }}>
          {status === 'HT' ? 'HT' : `${minute || '?'}'`}
        </span>
      </div>
    );
  }
  if (status === 'FT') {
    return <span style={{ fontSize: 11, color: '#4a5568', width: 56, flexShrink: 0 }}>FT</span>;
  }
  // NS — show kickoff time
  let timeStr = '--:--';
  if (kickoffUTC) {
    try {
      timeStr = new Date(kickoffUTC).toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
      });
    } catch {}
  }
  return (
    <span style={{ fontSize: 11, color: '#4a5568', width: 56, flexShrink: 0 }}>{timeStr}</span>
  );
}

function MatchRow({ match, isSelected, onSelect }) {
  const [hScore, aScore] = (match.score || '0-0').split('-');
  const isLive = match.status === 'LIVE' || match.status === '1H' || match.status === '2H';

  return (
    <div
      onClick={() => onSelect(match)}
      style={{
        display: 'flex', alignItems: 'center', gap: 0,
        padding: '11px 16px', cursor: 'pointer',
        background: isSelected ? '#001f0e' : 'transparent',
        borderLeft: isSelected ? '3px solid #00b859' : '3px solid transparent',
        borderBottom: '1px solid #131826',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#131826'; }}
      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Status / time */}
      <StatusCell status={match.status} minute={match.matchMinutes} kickoffUTC={match.kickoffUTC} />

      {/* Home team */}
      <div style={{
        flex: 1, fontSize: 13, fontWeight: 600,
        color: '#e2e8f0', textAlign: 'right',
        paddingRight: 12, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {match.home}
      </div>

      {/* Score / vs */}
      <div style={{ width: 60, textAlign: 'center', flexShrink: 0 }}>
        {(isLive || match.status === 'FT') ? (
          <span style={{
            fontSize: 14, fontWeight: 800,
            color: isLive ? '#e2e8f0' : '#4a5568',
            background: isLive ? '#1a1f2e' : 'transparent',
            borderRadius: 4, padding: '2px 6px',
          }}>
            {hScore} - {aScore}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: '#4a5568' }}>vs</span>
        )}
      </div>

      {/* Away team */}
      <div style={{
        flex: 1, fontSize: 13, fontWeight: 600,
        color: '#e2e8f0', textAlign: 'left',
        paddingLeft: 12, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {match.away}
      </div>

      {/* Confidence badge */}
      <div style={{ marginLeft: 12 }}>
        <ConfBadge score={match.confidence || 0} />
      </div>

      {/* Arrow */}
      <span style={{ marginLeft: 10, color: '#1e2535', fontSize: 11, flexShrink: 0 }}>▶</span>
    </div>
  );
}

export default function MatchFeed({ matches, selectedMatch, onSelectMatch }) {
  if (!matches || matches.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 14, color: '#4a5568',
      }}>
        <span style={{ fontSize: 44 }}>📭</span>
        <p style={{ fontSize: 14, fontWeight: 600 }}>No matches found</p>
        <p style={{ fontSize: 12 }}>Press Recalibrate Today to scan the global schedule</p>
      </div>
    );
  }

  // Group by league (preserve insertion order to keep relevant leagues first)
  const groups = new Map();
  for (const m of matches) {
    const key = `${m.leagueId}__${m.league}`;
    if (!groups.has(key)) {
      groups.set(key, { id: m.leagueId, name: m.league, country: m.leagueCountry, matches: [] });
    }
    groups.get(key).matches.push(m);
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {Array.from(groups.values()).map(group => (
        <div key={`${group.id}_${group.name}`}>
          {/* League section header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 16px',
            background: '#131826',
            borderTop: '1px solid #1e2535',
            borderBottom: '1px solid #1e2535',
            position: 'sticky', top: 0, zIndex: 2,
          }}>
            <span style={{ fontSize: 14 }}>{LEAGUE_FLAGS[group.id] || '⚽'}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#8b9ab3', letterSpacing: '0.5px', textTransform: 'uppercase' }}>
              {group.name}
            </span>
            {group.country && (
              <span style={{ fontSize: 10, color: '#4a5568' }}>· {group.country}</span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#4a5568' }}>
              {group.matches.length} match{group.matches.length !== 1 ? 'es' : ''}
            </span>
          </div>

          {/* Match rows */}
          {group.matches.map(m => (
            <MatchRow
              key={m.id}
              match={m}
              isSelected={selectedMatch?.id === m.id}
              onSelect={onSelectMatch}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
