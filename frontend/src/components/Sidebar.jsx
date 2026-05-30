import React, { useState } from 'react';

const LEAGUE_FLAGS = {
  // Europe — Top 5
  39: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 140: '🇪🇸', 78: '🇩🇪', 135: '🇮🇹', 61: '🇫🇷',
  // Europe — Other
  88: '🇳🇱', 94: '🇵🇹', 64: '🇵🇹', 203: '🇹🇷', 235: '🇷🇺',
  179: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 144: '🇧🇪', 236: '🇷🇺', 204: '🇹🇷',
  // UEFA / International club
  2: '🇪🇺', 3: '🟠', 848: '💜', 17: '🏆',
  13: '🌎', 11: '🌎',
  // International
  1: '⭐', 4: '🏆', 9: '🌎', 16: '🏅', 6: '🌍', 30: '🌎',
  // Middle East
  307: '🇸🇦', 541: '🇸🇦',
  // Asia / Pacific
  98: '🇯🇵', 292: '🇰🇷', 169: '🇨🇳', 313: '🇮🇩', 188: '🇦🇺',
  // Americas
  253: '🇺🇸', 71: '🇧🇷', 128: '🇦🇷', 239: '🇨🇴',
};

const FILTERS = [
  { id: 'all',  label: 'All Matches',   icon: '⚽' },
  { id: 'live', label: 'Live Now',      icon: '🔴' },
  { id: 'high', label: '80%+ Picks',   icon: '🔥' },
];

export default function Sidebar({ filter, setFilter, selectedLeague, setSelectedLeague, selectedCountry, setSelectedCountry, selectedKeyword, setSelectedKeyword, leagueCounts, open, onClose, isMobile }) {
  const [compSearch, setCompSearch] = useState('');
  const searchTerm = compSearch.trim().toLowerCase();

  const filteredLeagues = searchTerm
    ? leagueCounts.filter(l =>
        l.name.toLowerCase().includes(searchTerm) ||
        (l.country || '').toLowerCase().includes(searchTerm)
      )
    : leagueCounts;

  // Countries whose name matches the search term
  const matchedCountries = searchTerm
    ? [...new Set(
        filteredLeagues
          .filter(l => (l.country || '').toLowerCase().includes(searchTerm))
          .map(l => l.country)
      )].filter(Boolean)
    : [];

  // League-name keyword button: show when 2+ leagues match by name (CAF, UEFA, World Cup, Copa…)
  const leagueNameMatches = searchTerm
    ? filteredLeagues.filter(l => l.name.toLowerCase().includes(searchTerm))
    : [];
  const showKeywordButton = leagueNameMatches.length > 1;
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
          {/* Competition search */}
          <div style={{ padding: '0 8px 6px' }}>
            <input
              value={compSearch}
              onChange={e => setCompSearch(e.target.value)}
              placeholder="Search competition..."
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#131826', border: '1px solid #1e2535',
                borderRadius: 6, padding: '7px 10px',
                color: '#e2e8f0', fontSize: 12, outline: 'none',
              }}
            />
          </div>
          {!compSearch.trim() && (
            <button onClick={() => pick(() => { setSelectedLeague(null); setSelectedCountry(null); setSelectedKeyword(null); })} style={leagueBtn(selectedLeague === null && !selectedCountry && !selectedKeyword)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14 }}>🌐</span>
                <span>All Leagues</span>
              </div>
            </button>
          )}
          {/* Keyword quick-filter: "All UEFA matches", "All CAF matches", "All World Cup matches" etc. */}
          {showKeywordButton && (
            <button
              onClick={() => pick(() => { setSelectedKeyword(compSearch.trim()); setSelectedCountry(null); setSelectedLeague(null); setCompSearch(''); })}
              style={{
                ...leagueBtn(selectedKeyword?.toLowerCase() === searchTerm),
                background: '#1a0e00', borderLeft: '2px solid #f59e0b',
                color: '#f59e0b',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 13 }}>📌</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  All "{compSearch.trim()}" matches
                </span>
              </div>
              <span style={{ fontSize: 10, background: '#1e2535', borderRadius: 10, padding: '1px 6px', color: '#4a5568', flexShrink: 0 }}>
                {leagueNameMatches.reduce((s, l) => s + l.count, 0)}
              </span>
            </button>
          )}
          {/* Country quick-filter buttons when search matches a country */}
          {matchedCountries.map(country => (
            <button
              key={country}
              onClick={() => pick(() => { setSelectedCountry(country); setSelectedLeague(null); setSelectedKeyword(null); setCompSearch(''); })}
              style={{
                ...leagueBtn(selectedCountry === country),
                background: selectedCountry === country ? '#001f2e' : '#0d1420',
                borderLeft: selectedCountry === country ? '2px solid #3b82f6' : '2px solid transparent',
                color: selectedCountry === country ? '#60a5fa' : '#8b9ab3',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 13 }}>🌍</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  All {country} matches
                </span>
              </div>
              <span style={{ fontSize: 10, background: '#1e2535', borderRadius: 10, padding: '1px 6px', color: '#4a5568', flexShrink: 0 }}>
                {leagueCounts.filter(l => l.country === country).reduce((s, l) => s + l.count, 0)}
              </span>
            </button>
          ))}
          {/* Active country filter pill */}
          {selectedCountry && !compSearch.trim() && (
            <div style={{ padding: '4px 8px' }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: '#001f2e', border: '1px solid #1e4060', borderRadius: 6, padding: '5px 10px',
              }}>
                <span style={{ fontSize: 12, color: '#60a5fa' }}>🌍 {selectedCountry}</span>
                <button onClick={() => { setSelectedCountry(null); }} style={{ background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
              </div>
            </div>
          )}
          {/* Active keyword filter pill */}
          {selectedKeyword && !compSearch.trim() && (
            <div style={{ padding: '4px 8px' }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: '#1a0e00', border: '1px solid #78350f', borderRadius: 6, padding: '5px 10px',
              }}>
                <span style={{ fontSize: 12, color: '#f59e0b' }}>📌 {selectedKeyword}</span>
                <button onClick={() => { setSelectedKeyword(null); }} style={{ background: 'none', border: 'none', color: '#4a5568', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
              </div>
            </div>
          )}
          {filteredLeagues.length === 0 && compSearch.trim() && (
            <div style={{ padding: '8px 14px', fontSize: 12, color: '#4a5568' }}>No competition found</div>
          )}
          {filteredLeagues.map(({ id, name, count }) => (
            <button key={`${id}_${name}`} onClick={() => pick(() => { setSelectedLeague(id); setSelectedCountry(null); setSelectedKeyword(null); setCompSearch(''); })} style={leagueBtn(selectedLeague === id)}>
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
