import React, { useState, useEffect } from 'react';
import { connectWebSocket, disconnectWebSocket, on, off, apiService } from './services/api';
import Sidebar from './components/Sidebar';
import MatchFeed from './components/MatchFeed';
import DetailPanel from './components/DetailPanel';
import { BetLogger } from './components/BetComponents';
import BetSlips from './components/BetSlips';
import AlertHistory from './components/AlertHistory';
import PerformanceHub from './components/PerformanceHub';

const LIVE_STATUS_CODES = new Set(['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT']);

function mergeLiveIntoMatches(prev, incoming = []) {
  const live = Array.isArray(incoming) ? incoming : [];
  const liveIds = new Set(live.map((m) => String(m.id)));

  // Remove the previous live snapshot before inserting the new one.
  // This prevents finished/disappeared fixtures from lingering with stale scores.
  const rest = prev.filter((m) => {
    if (liveIds.has(String(m.id))) return false;
    if (m._source === 'live') return false;
    if (LIVE_STATUS_CODES.has(m.status)) return false;
    return true;
  });

  return [
    ...live.map((m) => ({ ...m, _source: 'live' })),
    ...rest,
  ];
}

export default function App() {
 const [allMatches, setAllMatches] = useState([]);
 const [filter, setFilter] = useState('all');
 const [selectedLeague, setSelectedLeague] = useState(null);
 const [selectedMatch, setSelectedMatch] = useState(null);
 const [selectedAnalysis, setSelectedAnalysis] = useState(null);
 const [connected, setConnected] = useState(false);
 const [loading, setLoading] = useState(true);
 const [calibrating, setCalibrating] = useState(false);
 const [calibratedAt, setCalibratedAt] = useState(null);
 const [searchQuery, setSearchQuery] = useState('');
 const [searching, setSearching] = useState(false);
 const [showBets, setShowBets] = useState(false);
 const [showAlerts, setShowAlerts] = useState(false);
 const [showRecord, setShowRecord] = useState(false);
 const [betTab, setBetTab] = useState('slips'); // 'slips' | 'logger'
 const [bets, setBets] = useState([]);
 const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
 const [sidebarOpen, setSidebarOpen] = useState(false);
 const [selectedCountry, setSelectedCountry] = useState(null);
 const [selectedKeyword, setSelectedKeyword] = useState(null);
 const [refreshingLive, setRefreshingLive] = useState(false);
 const [lastLiveUpdatedAt, setLastLiveUpdatedAt] = useState(null);

 useEffect(() => {
   const check = () => setIsMobile(window.innerWidth < 768);
   window.addEventListener('resize', check);
   return () => window.removeEventListener('resize', check);
 }, []);

 // â”€â”€ Merge helper: keep calibrated matches separate so they survive live updates â”€â”€
 function mergeInto(prev, incoming, source) {
 const calibrated = prev.filter(m => m._calibrated);
 const calIds = new Set(calibrated.map(m => m.id));
 const fresh = incoming
 .filter(m => !calIds.has(m.id))
 .map(m => ({ ...m, _source: source }));
 return [...fresh, ...calibrated];
 }

 useEffect(() => {
 connectWebSocket(() => {
 setConnected(true);
 setLoading(false);
 }).catch(() => setLoading(false));

 const handleLiveMatches = (p) => {
 setAllMatches(prev => mergeLiveIntoMatches(prev, p || []));
 setLastLiveUpdatedAt(Date.now());
 };

 const handleUpcomingMatches = (p) => {
 setAllMatches(prev => {
 const IN_PLAY = new Set(['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT']);
 const liveOnly = prev.filter(m => IN_PLAY.has(m.status) || m._calibrated);
 const liveIds = new Set(liveOnly.map(m => m.id));
 return [...liveOnly, ...(p || []).filter(m => !liveIds.has(m.id)).map(m => ({ ...m, _source: 'upcoming' }))];
 });
 };

 const handleBetLogged = (b) => setBets(p => [b, ...p]);
 const handleBetUpdated = (b) => setBets(p => p.map(x => x.id === b.id ? b : x));

 on('LIVE_MATCHES', handleLiveMatches);
 on('UPCOMING_MATCHES', handleUpcomingMatches);
 on('BET_LOGGED', handleBetLogged);
 on('BET_UPDATED', handleBetUpdated);

 const fetchInitial = async () => {
 try {
 const [liveRes, upRes, betsRes] = await Promise.all([
 apiService.getLiveMatches().catch(() => ({ data: { matches: [] } })),
 apiService.getUpcoming().catch(() => ({ data: { matches: [] } })),
 apiService.getBets().catch(() => ({ data: { bets: [] } })),
 ]);
 const live = liveRes?.data?.matches || [];
 const upcoming = upRes?.data?.matches || [];
 const liveIds = new Set(live.map(m => m.id));
 setAllMatches([
   ...live.map(m => ({ ...m, _source: 'live' })),
   ...upcoming.filter(m => !liveIds.has(m.id)).map(m => ({ ...m, _source: 'upcoming' })),
 ]);
 setLastLiveUpdatedAt(Date.now());
 setBets(betsRes?.data?.bets || []);

 // Restore last calibration results if available
 const calRes = await apiService.client.get('/calibrate/results').catch(() => null);
 if (calRes?.data?.matches?.length > 0) {
 setCalibratedAt(calRes.data.calibratedAt);
 setAllMatches(prev => {
 const prevIds = new Set(prev.map(m => m.id));
 const newCal = calRes.data.matches
 .filter(m => !prevIds.has(m.id))
 .map(m => ({ ...m, _calibrated: true, _source: 'calibrated' }));
 return [...prev, ...newCal];
 });
 }
 } catch {}
 setLoading(false);
 };

 fetchInitial();

 // V10.5A: the backend performs one shared lightweight live refresh while portal users are connected.
 // WebSocket pushes score/status changes. Pull-to-refresh and the Live button use the same backend route.

 return () => {
 off('LIVE_MATCHES', handleLiveMatches);
 off('UPCOMING_MATCHES', handleUpcomingMatches);
 off('BET_LOGGED', handleBetLogged);
 off('BET_UPDATED', handleBetUpdated);
 disconnectWebSocket();
 };
 }, []);

 // â”€â”€ Recalibrate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 async function handleCalibrate() {
 setCalibrating(true);
 try {
 const res = await apiService.client.post('/calibrate');
 const data = res.data;
 setCalibratedAt(data.calibratedAt);

 setAllMatches(prev => {
 const nonCal = prev.filter(m => !m._calibrated);
 const nonIds = new Set(nonCal.map(m => m.id));
 const newCal = (data.matches || [])
 .filter(m => !nonIds.has(m.id))
 .map(m => ({ ...m, _calibrated: true, _source: 'calibrated' }));
 return [...nonCal, ...newCal];
 });
 } catch (err) {
 console.error('Calibrate failed:', err.response?.data?.error || err.message);
 } finally {
 setCalibrating(false);
 }
 }

 // â”€â”€ Search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 async function handleManualLiveRefresh() {
 if (refreshingLive) return;
 setRefreshingLive(true);
 try {
 const res = await apiService.getLiveMatches();
 const live = res?.data?.matches || [];
 setAllMatches(prev => mergeLiveIntoMatches(prev, live));
 setLastLiveUpdatedAt(Date.now());
 } catch (err) {
 console.error('Live refresh failed:', err.response?.data?.error || err.message);
 } finally {
 setRefreshingLive(false);
 }
 }

 async function handleSearch(e) {
 e?.preventDefault();
 if (!searchQuery.trim()) return;
 setSearching(true);
 try {
 const res = await apiService.client.get(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
 const payload = res?.data || {};
 const matches = Array.isArray(payload.matches) ? payload.matches : [];

 if (matches.length === 0) {
   throw new Error(payload.message || 'No authoritative fixture found');
 }

 // Search results must be real cached/live/upcoming fixtures from the backend.
 // Never create pseudo statistics or placeholder confidence values.
 const authoritative = matches.map(m => ({
   ...m,
   _source: m._source || 'search',
 }));

 setAllMatches(prev => {
   const byId = new Map(prev.map(m => [String(m.id), m]));
   for (const m of authoritative) {
     byId.set(String(m.id), { ...byId.get(String(m.id)), ...m });
   }
   return Array.from(byId.values());
 });

 const first = authoritative[0];
 setSelectedMatch(first);
 setSelectedAnalysis(first.analysis || null);
 } catch (err) {
 console.error('Search failed:', err.response?.data?.message || err.response?.data?.error || err.message);
 } finally {
 setSearching(false);
 }
 }

 // ── Derived state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 const LIVE_STATUSES = new Set(['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT']);
 const displayedMatches = allMatches.filter(m => {
 if (filter === 'live' && !LIVE_STATUSES.has(m.status)) return false;
 if (filter === 'high') {
 const dailySignal = m.dailySignal || m.analysis?.dailySignal || null;
 const signalScore = Number(dailySignal?.score ?? 0);
 // Daily 80+ is a pre-match evidence selector, not a generic confidence filter.
 // Only fully analyzed fixtures that pass Agent47's evidence gate qualify.
 if (dailySignal?.eligible !== true || !Number.isFinite(signalScore) || signalScore < 80) return false;
 }
 if (selectedKeyword && !(m.league || '').toLowerCase().includes(selectedKeyword.toLowerCase())) return false;
 if (selectedCountry && !selectedKeyword && (m.leagueCountry || '').toLowerCase() !== selectedCountry.toLowerCase()) return false;
 if (selectedLeague != null && !selectedCountry && !selectedKeyword && m.leagueId !== selectedLeague) return false;
 return true;
 });

 useEffect(() => {
 if (!selectedMatch?.id) return;
 const fresh = allMatches.find((m) => m.id === selectedMatch.id);
 if (!fresh) return;
 setSelectedMatch((prev) => {
 if (!prev) return prev;
 if (
 prev.score === fresh.score &&
 prev.status === fresh.status &&
 prev.matchMinutes === fresh.matchMinutes &&
 prev.confidence === fresh.confidence
 ) {
 return prev;
 }
 return { ...prev, ...fresh };
 });
 if (fresh.analysis) {
 setSelectedAnalysis(fresh.analysis);
 }
 }, [allMatches, selectedMatch?.id]);

 const leagueCounts = (() => {
 const counts = {};
 for (const m of allMatches) {
 if (!counts[m.leagueId]) counts[m.leagueId] = { id: m.leagueId, name: m.league || 'Unknown', count: 0, country: m.leagueCountry || '' };
 counts[m.leagueId].count++;
 }
 return Object.values(counts).sort((a, b) => b.count - a.count);
 })();

 function handleSelectMatch(m) {
 setSelectedMatch(m);
 setSelectedAnalysis(m.analysis || null);
 setShowBets(false);
 setShowRecord(false);
 }

 // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 return (
 <div style={{ background: '#0f1117', height: '100vh', color: '#e2e8f0', fontFamily: "'Inter', system-ui, sans-serif", display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

 {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• HEADER â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
 <header style={{
 background: '#0a0d15', borderBottom: '1px solid #1e2535',
 padding: '0 18px', height: 56,
 display: 'flex', alignItems: 'center', gap: 14,
 flexShrink: 0, zIndex: 10,
 }}>

 {/* Hamburger — mobile only */}
 {isMobile && (
   <button
     onClick={() => setSidebarOpen(v => !v)}
     style={{
       background: 'none', border: '1px solid #1e2535', borderRadius: 6,
       color: '#8b9ab3', fontSize: 18, lineHeight: 1,
       padding: '6px 10px', cursor: 'pointer', flexShrink: 0,
     }}
   >
     ☰
   </button>
 )}

 {/* Logo */}
 <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, cursor: 'pointer' }}
 onClick={() => { setSelectedMatch(null); setSelectedAnalysis(null); setShowBets(false); setShowAlerts(false); setShowRecord(false); }}>
 <span style={{ fontSize: 20 }}>&#9889;</span>
 <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.5px' }}>
 <span style={{ color: '#e2e8f0' }}>Sporty</span><span style={{ color: '#00b859' }}>Rabbi</span>
 </span>
 <span style={{ fontSize: 9, fontWeight: 700, color: '#4a5568', letterSpacing: 1, background: '#1e2535', borderRadius: 3, padding: '1px 4px' }}>V10</span>
 </div>

 {/* Daily preparation status — intentionally not a manual API trigger */}
 <div
 title="SportyRabbi prepares the day automatically at 05:00 UK time"
 style={{
 display: 'flex', alignItems: 'center', gap: 6,
 background: '#001f0e', border: '1px solid #006833', borderRadius: 7,
 padding: '7px 13px', color: '#00b859', fontSize: 12, fontWeight: 700, flexShrink: 0,
 }}
 >
 <span style={{ fontSize: 13 }}>☀</span>
 Daily Prep 05:00 UK
 </div>

 <button
 title="Refresh live scores now"
 onClick={handleManualLiveRefresh}
 disabled={refreshingLive}
 style={{
 background: '#131826', border: '1px solid #2d3748', borderRadius: 7,
 padding: isMobile ? '7px 9px' : '7px 11px',
 color: refreshingLive ? '#4a5568' : '#8b9ab3',
 fontSize: 12, fontWeight: 700, cursor: refreshingLive ? 'not-allowed' : 'pointer',
 flexShrink: 0,
 }}
 >
 {refreshingLive ? 'Refreshing...' : (isMobile ? 'Refresh' : 'Refresh Live')}
 </button>

 {lastLiveUpdatedAt && !isMobile && (
 <span
 title="Most recent live-state update received by this browser"
 style={{ fontSize: 10, color: '#4a5568', flexShrink: 0 }}
 >
 Live {new Date(lastLiveUpdatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
 </span>
 )}

 {calibratedAt && (
 <span style={{ fontSize: 10, color: '#4a5568', flexShrink: 0 }}>
 {new Date(calibratedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
 </span>
 )}

 {/* Search bar */}
 <form onSubmit={handleSearch} style={{ flex: 1, maxWidth: 400, display: 'flex', gap: 0 }}>
 <input
 value={searchQuery}
 onChange={e => setSearchQuery(e.target.value)}
 placeholder="Search team e.g. Arsenal, Napoli tonight..."
 style={{
 flex: 1, background: '#131826', border: '1px solid #1e2535',
 borderRight: 'none', borderRadius: '7px 0 0 7px',
 padding: '8px 14px', color: '#e2e8f0', fontSize: 12, outline: 'none',
 }}
 />
 <button
 type="submit"
 disabled={searching}
 style={{
 background: '#00b859', border: '1px solid #00b859',
 borderRadius: '0 7px 7px 0', padding: '8px 16px',
 cursor: searching ? 'not-allowed' : 'pointer',
 color: '#fff', fontSize: 14, fontWeight: 700,
 opacity: searching ? 0.7 : 1,
 }}
 >
 {searching ? '...' : '\uD83D\uDD0D'}
 </button>
 </form>

 {/* Right side */}
 <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
 <button
 onClick={() => { setShowRecord(v => !v); setShowBets(false); setShowAlerts(false); setSelectedMatch(null); }}
 style={{
 background: showRecord ? '#001f0e' : 'transparent',
 border: '1px solid ' + (showRecord ? '#006833' : '#1e2535'),
 borderRadius: 7, padding: '7px 13px', cursor: 'pointer',
 color: showRecord ? '#00b859' : '#8b9ab3', fontSize: 12, fontWeight: 700,
 }}
 >
 Record
 </button>

 <button
 onClick={() => { setShowBets(v => !v); setShowAlerts(false); setShowRecord(false); setSelectedMatch(null); }}
 style={{
 background: showBets ? '#2d1b69' : 'transparent',
 border: '1px solid ' + (showBets ? '#7c3aed' : '#1e2535'),
 borderRadius: 7, padding: '7px 13px', cursor: 'pointer',
 color: showBets ? '#a78bfa' : '#8b9ab3', fontSize: 12, fontWeight: 700,
 }}
 >
 Bet Tools
 </button>

 <button
 onClick={() => { setShowAlerts(v => !v); setShowBets(false); setShowRecord(false); setSelectedMatch(null); }}
 style={{
 background: showAlerts ? '#1a1200' : 'transparent',
 border: '1px solid ' + (showAlerts ? '#f59e0b' : '#1e2535'),
 borderRadius: 7, padding: '7px 13px', cursor: 'pointer',
 color: showAlerts ? '#f59e0b' : '#8b9ab3', fontSize: 12, fontWeight: 700,
 }}
 >
 Alerts
 </button>

 <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
 <span style={{
 width: 7, height: 7, borderRadius: '50%',
 background: connected ? '#00b859' : '#ef4444',
 display: 'inline-block',
 boxShadow: connected ? '0 0 8px #00b85966' : 'none',
 }} />
 <span style={{ fontSize: 11, fontWeight: 700, color: connected ? '#00b859' : '#ef4444' }}>
 {connected ? 'LIVE' : 'OFFLINE'}
 </span>
 </div>
 </div>

 </header>

 {/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• BODY â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */}
 <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

 {/* LEFT SIDEBAR — always mounted, mobile turns it into a drawer overlay */}
 {!showBets && !showAlerts && !showRecord && (
 <Sidebar
 filter={filter}
 setFilter={setFilter}
 selectedLeague={selectedLeague}
 setSelectedLeague={setSelectedLeague}
 selectedCountry={selectedCountry}
 setSelectedCountry={setSelectedCountry}
 selectedKeyword={selectedKeyword}
 setSelectedKeyword={setSelectedKeyword}
 leagueCounts={leagueCounts}
 open={sidebarOpen}
 onClose={() => setSidebarOpen(false)}
 isMobile={isMobile}
 />
 )}

 {/* TRACK RECORD / ALERTS / BET TOOLS */}
 {showRecord ? (
 <PerformanceHub bets={bets} />
 ) : showAlerts ? (
 <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
 <AlertHistory />
 </div>
 ) : showBets ? (
 <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
 {/* Bet panel tab bar */}
 <div style={{
 display: 'flex', gap: 0, borderBottom: '1px solid #1e2535',
 background: '#0a0d15', flexShrink: 0,
 }}>
 {[['slips', 'V8 Bet Slips'], ['logger', 'Bet Logger']].map(([id, label]) => (
 <button
 key={id}
 onClick={() => setBetTab(id)}
 style={{
 padding: '10px 18px', border: 'none', cursor: 'pointer',
 background: 'transparent',
 borderBottom: betTab === id ? '2px solid #00b859' : '2px solid transparent',
 color: betTab === id ? '#00b859' : '#8b9ab3',
 fontSize: 12, fontWeight: betTab === id ? 700 : 500,
 }}
 >
 {label}
 </button>
 ))}
 </div>
 {betTab === 'slips' ? (
 <BetSlips />
 ) : (
 <div style={{ flex: 1, padding: '24px 28px', overflowY: 'auto' }}>
 <BetLogger onBetLogged={b => setBets(p => [b, ...p])} />
 </div>
 )}
 </div>
 ) : (
 <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
 {/* Feed info bar */}
 <div style={{
 padding: '9px 16px', borderBottom: '1px solid #1e2535',
 background: '#0a0d15', flexShrink: 0,
 display: 'flex', alignItems: 'center', gap: 12,
 }}>
 <span style={{ fontSize: 12, color: '#8b9ab3', fontWeight: 600 }}>
 {filter === 'high' ? ' 80%+ Signal Candidates' : filter === 'live' ? ' Live Now' : ' Today\'s Matches'}
 </span>
 <span style={{ fontSize: 11, color: '#4a5568' }}>
 {displayedMatches.length} match{displayedMatches.length !== 1 ? 'es' : ''}
 </span>
 {loading && <span style={{ fontSize: 11, color: '#4a5568', marginLeft: 4 }}>Loading...</span>}
 </div>

 <MatchFeed
 matches={displayedMatches}
 selectedMatch={selectedMatch}
 onSelectMatch={handleSelectMatch}
 onRefresh={handleManualLiveRefresh}
 />
 </div>
 )}

 {/* RIGHT DETAIL PANEL */}
 {selectedMatch && !showBets && !showAlerts && !showRecord && (
 <DetailPanel
 match={selectedMatch}
 analysis={selectedAnalysis}
 bets={bets}
 onClose={() => { setSelectedMatch(null); setSelectedAnalysis(null); }}
 />
 )}

 </div>

 </div>
 );
}

