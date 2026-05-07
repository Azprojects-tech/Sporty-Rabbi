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

const FILTERS = [
  { id: 'all',  label: 'All Matches',   icon: '⚽' },
  { id: 'live', label: 'Live Now',      icon: '🔴' },
  { id: 'high', label: '80%+ Picks',   icon: '🔥' },
];

export default function Sidebar({ filter, setFilter, selectedLeague, setSelectedLeague, leagueCounts, open, onClose, isMobile }) {
  // On desktop: always visible inline. On mobile: slide-in overlay.
  const sidebarStyle = isMobile ? {
    position: 'fixed', top: 56, left: 0, bottom: 0, zIndex: 200,
    width: 240,
    background: '#0a0d15',
    borderRight: '1px solid #1e2535',
    display: 'flex', flexDirection: 'column',
    overflowY: 'auto',
    transform: open ? 'translateX(0)' : 'translateX(-100%)',
    transition: 'transform 0.22s ease',
    boxShadow: open ? '4px 0 24px #00000088' : 'none',
  } : {
    width: 200, flexShrink: 0,
    background: '#0a0d15',
    borderRight: '1px solid #1e2535',
    display: 'flex', flexDirection: 'column',
    height: 'calc(100vh - 56px)', overflowY: 'auto',
  };

  const filterBtn = (active) => ({
    width: '100%', display: 'flex', alignItems: 'center', gap: 9,
    padding: '10px 14px', borderRadius: 6, marginBottom: 2,
    background: active ? '#001f0e' : 'transparent',
    border: 'none', cursor: 'pointer',
    borderLeft: active ? '3px solid #00b859' : '3px solid transparent',
    color: active ? '#00b859' : '#8b9ab3',
    fontSize: 13, fontWeight: active ? 700 : 500,
    textAlign: 'left',
  });

  const leagueBtn = (active) => ({
    width: '100%', display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', gap: 8,
    padding: '8px 14px',
    background: active ? '#001f0e' : 'transparent',
    border: 'none', cursor: 'pointer',
    borderLeft: active ? '2px solid #00b859' : '2px solid transparent',
    color: active ? '#00b859' : '#8b9ab3',
    fontSize: 12, fontWeight: active ? 700 : 400,
    textAlign: 'left',
  });

  function pick(action) {
    action();
    if (isMobile) onClose();
  }

  return (
    <>
      {/* Mobile backdrop */}
      {isMobile && open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, top: 56, zIndex: 199,
            background: '#00000066',
          }}
        />
      )}

      <aside style={sidebarStyle}>
        {/* Close button on mobile */}
        {isMobile && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 12px 0' }}>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', color: '#4a5568',
              fontSize: 22, cursor: 'pointer', lineHeight: 1,
            }}>×</button>
          </div>
        )}

        {/* ── Filter tabs ─────────────────────────── */}
        <div style={{ padding: '12px 8px', borderBottom: '1px solid #1e2535' }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => pick(() => setFilter(f.id))} style={filterBtn(filter === f.id)}>
              <span style={{ fontSize: 14 }}>{f.icon}</span>
              <span>{f.label}</span>
            </button>
          ))}
        </div>

        {/* ── League list ─────────────────────────── */}
        <div style={{ padding: '8px 0', flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '1px', color: '#4a5568', padding: '6px 14px 4px', textTransform: 'uppercase' }}>
            Competitions
          </div>
          <button onClick={() => pick(() => setSelectedLeague(null))} style={leagueBtn(selectedLeague === null)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14 }}>🌐</span>
              <span>All Leagues</span>
            </div>
          </button>
          {leagueCounts.map(({ id, name, count }) => (
            <button key={`${id}_${name}`} onClick={() => pick(() => setSelectedLeague(id))} style={leagueBtn(selectedLeague === id)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 14, flexShrink: 0 }}>{LEAGUE_FLAGS[id] || '⚽'}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
              </div>
              <span style={{
                fontSize: 10, background: '#1e2535', borderRadius: 10,
                padding: '1px 6px', color: '#4a5568', flexShrink: 0,
              }}>{count}</span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
