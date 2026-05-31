import React, { memo, useMemo, useState, useCallback, useRef } from 'react';

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

const LIVE_STATUSES = new Set(['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT']);

function isWomens(league = '', home = '', away = '') {
  const l = league.toLowerCase();
  if (l.includes('women') || l.includes('femenin') || l.includes('feminine') ||
      l.includes('ladies') || l.includes('damen') || l.includes('feminino') ||
      l.includes('mujer') || l.includes('w league') || /\bw\b/.test(l)) return true;
  if ((home || '').endsWith(' W') && (away || '').endsWith(' W')) return true;
  return false;
}

function displayLeagueName(name = '', home = '', away = '') {
  if (!isWomens(name, home, away)) return name;
  const l = name.toLowerCase();
  if (l.includes('women') || l.includes('femenin') || l.includes('ladies') ||
      l.includes('feminine') || l.includes('w league') || l.includes('damen')) return name;
  return `${name} (Women)`;
}

function MatchRow({ match, isSelected, onSelect }) {
  const [hScore, aScore] = (match.score || '0-0').split('-');
  const isLive = LIVE_STATUSES.has(match.status);

  return (
    <div
      onClick={() => onSelect(match)}
      className="match-row"
      style={{
        display: 'flex', alignItems: 'center', gap: 0,
        padding: '11px 16px', cursor: 'pointer',
        background: isSelected ? '#001f0e' : 'transparent',
        borderLeft: isSelected ? '3px solid #00b859' : '3px solid transparent',
        borderBottom: '1px solid #131826',
      }}
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

      {/* Confidence badge — only shown when real V8 analysis ran (hides the 50% NS placeholder) */}
      {(isLive || match.status === 'FT' || (match.confidence || 0) >= 55) && (
        <div style={{ marginLeft: 12 }}>
          <ConfBadge score={match.confidence || 0} />
        </div>
      )}

      {/* Arrow */}
      <span style={{ marginLeft: 10, color: '#1e2535', fontSize: 11, flexShrink: 0 }}>▶</span>
    </div>
  );
}

const MatchRowMemo = memo(MatchRow, (prev, next) =>
  prev.match === next.match && prev.isSelected === next.isSelected
);

const PULL_THRESHOLD = 70;

function MatchFeedInner({ matches, selectedMatch, onSelectMatch, onRefresh }) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [pullDist, setPullDist] = useState(0);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [refreshing, setRefreshing] = useState(false);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const touchStartY = useRef(0);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const scrollRef = useRef(null);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const handleTouchStart = useCallback((e) => {
    touchStartY.current = e.touches[0].clientY;
  }, []);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const handleTouchMove = useCallback((e) => {
    if (refreshing || !scrollRef.current) return;
    if (scrollRef.current.scrollTop > 0) return;
    const dist = e.touches[0].clientY - touchStartY.current;
    if (dist > 0) setPullDist(Math.min(dist, PULL_THRESHOLD * 1.5));
  }, [refreshing]);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const handleTouchEnd = useCallback(async () => {
    if (pullDist >= PULL_THRESHOLD && onRefresh && !refreshing) {
      setPullDist(0);
      setRefreshing(true);
      try { await onRefresh(); } finally { setRefreshing(false); }
    } else {
      setPullDist(0);
    }
  }, [pullDist, onRefresh, refreshing]);

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

  // Group by league — memoized to avoid rebuilding on every render
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const groups = useMemo(() => {
    const g = new Map();
    for (const m of matches) {
      const key = `${m.leagueId}__${m.league}`;
      if (!g.has(key)) {
        g.set(key, { id: m.leagueId, name: m.league, country: m.leagueCountry, matches: [] });
      }
      g.get(key).matches.push(m);
    }
    return g;
  }, [matches]);

  const pullProgress = Math.min(pullDist / PULL_THRESHOLD, 1);
  const showIndicator = refreshing || pullDist > 8;

  return (
    <div
      ref={scrollRef}
      style={{ flex: 1, overflowY: 'auto' }}
      onTouchStart={onRefresh ? handleTouchStart : undefined}
      onTouchMove={onRefresh ? handleTouchMove : undefined}
      onTouchEnd={onRefresh ? handleTouchEnd : undefined}
    >
      {/* Pull-to-refresh indicator */}
      {showIndicator && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '10px 0', background: '#0a0d15',
          borderBottom: '1px solid #1e2535',
          transition: 'opacity 0.15s',
        }}>
          <span style={{
            display: 'inline-block', fontSize: 15,
            color: pullProgress >= 1 || refreshing ? '#00b859' : '#4a5568',
            animation: refreshing ? 'spin 0.7s linear infinite' : 'none',
            transform: refreshing ? 'none' : `rotate(${pullProgress * 180}deg)`,
            transition: 'color 0.2s, transform 0.1s',
          }}>↻</span>
          <span style={{ fontSize: 11, color: pullProgress >= 1 || refreshing ? '#00b859' : '#4a5568', transition: 'color 0.2s' }}>
            {refreshing ? 'Refreshing...' : pullProgress >= 1 ? 'Release to refresh' : 'Pull to refresh'}
          </span>
        </div>
      )}
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
              {displayLeagueName(group.name, group.matches[0]?.home, group.matches[0]?.away)}
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
            <MatchRowMemo
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

export default memo(MatchFeedInner);
