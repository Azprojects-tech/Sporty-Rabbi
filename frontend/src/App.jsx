import React, { useState, useEffect } from 'react';
import { connectWebSocket, on, apiService } from './services/api';
import Sidebar from './components/Sidebar';
import MatchFeed from './components/MatchFeed';
import DetailPanel from './components/DetailPanel';
import { BetLogger } from './components/BetComponents';
import BetSlips from './components/BetSlips';

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
 const [betTab, setBetTab] = useState('slips'); // 'slips' | 'logger'
 const [bets, setBets] = useState([]);

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

 on('LIVE_MATCHES', (p) => {
 setAllMatches(prev => {
 const liveIds = new Set((p || []).map(m => m.id));
 const rest = prev.filter(m => !liveIds.has(m.id));
 return [...(p || []).map(m => ({ ...m, _source: 'live' })), ...rest];
 });
 });

 on('UPCOMING_MATCHES', (p) => {
 setAllMatches(prev => {
 const liveOnly = prev.filter(m => m.status === 'LIVE' || m._calibrated);
 const liveIds = new Set(liveOnly.map(m => m.id));
 return [...liveOnly, ...(p || []).filter(m => !liveIds.has(m.id)).map(m => ({ ...m, _source: 'upcoming' }))];
 });
 });

 on('BET_LOGGED', (b) => setBets(p => [b, ...p]));
 on('BET_UPDATED', (b) => setBets(p => p.map(x => x.id === b.id ? b : x)));

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
 setAllMatches([...live, ...upcoming.filter(m => !liveIds.has(m.id))]);
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

 // Refresh live matches every 30s
 const t = setInterval(() => {
 apiService.getLiveMatches().then(r => {
 const live = r?.data?.matches || [];
 if (live.length > 0) {
 setAllMatches(prev => {
 const liveIds = new Set(live.map(m => m.id));
 const rest = prev.filter(m => !liveIds.has(m.id));
 return [...live, ...rest];
 });
 }
 }).catch(() => {});
 }, 30000);

 return () => clearInterval(t);
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
 async function handleSearch(e) {
 e?.preventDefault();
 if (!searchQuery.trim()) return;
 setSearching(true);
 try {
 const res = await apiService.client.get(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
 const analysis = res.data;
 const pseudo = {
 id: `search_${Date.now()}`,
 home: analysis.home || '?',
 away: analysis.away || '?',
 league: analysis.league || 'Search Result',
 leagueId: 0,
 score: '0-0',
 status: analysis.status || 'NS',
 matchMinutes: 0,
 confidence: analysis.overallScore || 50,
 possession: { home: 50, away: 50 },
 shots: { home: 0, away: 0 },
 xg: { home: 0, away: 0 },
 opportunities:[],
 leagueCountry:'',
 _source: 'search',
 };
 setSelectedMatch(pseudo);
 setSelectedAnalysis(analysis);
 } catch (err) {
 console.error('Search failed:', err.response?.data?.error || err.message);
 } finally {
 setSearching(false);
 }
 }

 // â”€â”€ Derived state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 const displayedMatches = allMatches.filter(m => {
 if (filter === 'live' && m.status !== 'LIVE') return false;
 if (filter === 'high' && (m.confidence || 0) < 80) return false;
 if (selectedLeague != null && m.leagueId !== selectedLeague) return false;
 return true;
 });

 const leagueCounts = (() => {
 const counts = {};
 for (const m of allMatches) {
 if (!counts[m.leagueId]) counts[m.leagueId] = { id: m.leagueId, name: m.league || 'Unknown', count: 0 };
 counts[m.leagueId].count++;
 }
 return Object.values(counts).sort((a, b) => b.count - a.count);
 })();

 function handleSelectMatch(m) {
 setSelectedMatch(m);
 setSelectedAnalysis(m.analysis || null);
 setShowBets(false);
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

 {/* Logo */}
 <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, cursor: 'pointer' }}
 onClick={() => { setSelectedMatch(null); setSelectedAnalysis(null); setShowBets(false); }}>
 <span style={{ fontSize: 20 }}>&#9889;</span>
 <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.5px' }}>
 <span style={{ color: '#e2e8f0' }}>Sporty</span><span style={{ color: '#00b859' }}>Rabbi</span>
 </span>
 <span style={{ fontSize: 9, fontWeight: 700, color: '#4a5568', letterSpacing: 1, background: '#1e2535', borderRadius: 3, padding: '1px 4px' }}>V8</span>
 </div>

 {/* Recalibrate */}
 <button
 onClick={handleCalibrate}
 disabled={calibrating}
 style={{
 display: 'flex', alignItems: 'center', gap: 6,
 background: calibrating ? '#0a1f12' : '#001f0e',
 border: '1px solid #006833', borderRadius: 7,
 padding: '7px 13px', cursor: calibrating ? 'not-allowed' : 'pointer',
 color: '#00b859', fontSize: 12, fontWeight: 700, flexShrink: 0,
 opacity: calibrating ? 0.7 : 1,
 }}
 >
 <span style={{ display: 'inline-block', animation: calibrating ? 'spin 0.8s linear infinite' : 'none', fontSize: 13 }}>
 {calibrating ? '↻' : '↻'}
 </span>
 {calibrating ? 'Calibrating...' : 'Recalibrate Today'}
 </button>

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
 onClick={() => { setShowBets(v => !v); setSelectedMatch(null); }}
 style={{
 background: showBets ? '#2d1b69' : 'transparent',
 border: '1px solid ' + (showBets ? '#7c3aed' : '#1e2535'),
 borderRadius: 7, padding: '7px 13px', cursor: 'pointer',
 color: showBets ? '#a78bfa' : '#8b9ab3', fontSize: 12, fontWeight: 700,
 }}
 >
 Bets
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

 {/* LEFT SIDEBAR */}
 {!showBets && (
 <Sidebar
 filter={filter}
 setFilter={setFilter}
 selectedLeague={selectedLeague}
 setSelectedLeague={setSelectedLeague}
 leagueCounts={leagueCounts}
 />
 )}

 {/* CENTER FEED */}
 {showBets ? (
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
 {filter === 'high' ? ' High Confidence Picks (>=80%)' : filter === 'live' ? ' Live Now' : ' Today\'s Matches'}
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
 />
 </div>
 )}

 {/* RIGHT DETAIL PANEL */}
 {selectedMatch && !showBets && (
 <DetailPanel
 match={selectedMatch}
 analysis={selectedAnalysis}
 onClose={() => { setSelectedMatch(null); setSelectedAnalysis(null); }}
 />
 )}

 </div>

 </div>
 );
}

