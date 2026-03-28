import React, { useState, useEffect } from 'react';
import { connectWebSocket, on, apiService } from './services/api';
import { MatchCard } from './components/MatchComponents';
import { BetLogger } from './components/BetComponents';
import AnalyticsModal from './components/AnalyticsModal';

export default function App() {
  const [matches, setMatches] = useState([]);
  const [upcomingMatches, setUpcomingMatches] = useState([]);
  const [bets, setBets] = useState([]);
  const [stats, setStats] = useState(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('live');
  const [subTab, setSubTab] = useState('leagues');
  const [selectedLeague, setSelectedLeague] = useState('all');
  const [selectedInternational, setSelectedInternational] = useState('all');
  const [selectedMatch, setSelectedMatch] = useState(null);

  // League dropdown options
  const leagueOptions = [
    { id: 'all', name: 'All Leagues', emoji: '📺' },
    { id: 203, name: 'Turkey - Supa Liga', emoji: '🇹🇷' },
    { id: 134, name: 'Argentina - Federal A', emoji: '🇦🇷' },
    { id: 71, name: 'Brazil - Serie A', emoji: '🇧🇷' },
    { id: 94, name: 'Portugal - Primeira Liga', emoji: '🇵🇹' },
  ];

  // International dropdown options
  const internationalOptions = [
    { id: 'all', name: 'All International', emoji: '🌍' },
    { id: 10, name: 'Friendlies', emoji: '⚽' },
    { id: 667, name: 'Friendlies Clubs', emoji: '🏆' },
  ];

  useEffect(() => {
    // Connect to WebSocket
    connectWebSocket(() => {
      setConnected(true);
      setLoading(false);
    }).catch((err) => {
      console.error('Failed to connect:', err);
      setLoading(false);
    });

    // Listen for live match updates
    on('LIVE_MATCHES', (payload) => {
      console.log('📊 Setting live matches:', payload?.length || 0);
      setMatches(payload || []);
    });

    // Listen for upcoming matches
    on('UPCOMING_MATCHES', (payload) => {
      console.log('📅 Setting upcoming matches:', payload?.length || 0);
      setUpcomingMatches(payload || []);
    });

    // Listen for alerts
    on('ALERT', (alert) => {
      console.log('🔔 New alert:', alert);
      // Show notification
    });

    // Listen for bet updates
    on('BET_LOGGED', (bet) => {
      setBets((prev) => [bet, ...prev]);
    });

    on('BET_UPDATED', (bet) => {
      setBets((prev) => prev.map((b) => (b.id === bet.id ? bet : b)));
    });

    // Fetch all data via HTTP (both initial and as fallback for WebSocket)
    const fetchData = async () => {
      try {
        const [matchesRes, upcomingRes, betsRes, statsRes] = await Promise.all([
          apiService.getLiveMatches().catch((e) => {
            console.error('❌ Error fetching live:', e.message);
            return { data: { matches: [] } };
          }),
          apiService.getUpcoming().catch((e) => {
            console.error('❌ Error fetching upcoming:', e.message);
            return { data: { matches: [] } };
          }),
          apiService.getBets().catch((e) => {
            console.error('❌ Error fetching bets:', e.message);
            return { data: { bets: [] } };
          }),
          apiService.getStats().catch((e) => {
            console.error('❌ Error fetching stats:', e.message);
            return { data: {} };
          }),
        ]);
        
        console.log('📡 API Response - Live:', matchesRes?.data);
        console.log('📡 API Response - Upcoming:', upcomingRes?.data);
        
        if (matchesRes?.data?.matches?.length > 0) {
          console.log('🔴 Got', matchesRes.data.matches.length, 'live matches');
          setMatches(matchesRes.data.matches);
        }
        if (upcomingRes?.data?.matches?.length > 0) {
          console.log('⏰ Got', upcomingRes.data.matches.length, 'upcoming matches');
          setUpcomingMatches(upcomingRes.data.matches);
        }
        setBets(betsRes?.data?.bets || []);
        setStats(statsRes?.data);
      } catch (err) {
        console.error('Error fetching data:', err);
      }
    };

    fetchData();
    
    // Re-fetch data every 10 seconds to keep it fresh
    const fetchInterval = setInterval(fetchData, 10000);
    
    return () => clearInterval(fetchInterval);
  }, []);

  // Get matches for current tab (Live/Upcoming)
  const currentMatches = activeTab === 'live' ? matches : upcomingMatches;

  // Filter by league selection
  const filteredLeagueMatches = selectedLeague === 'all'
    ? currentMatches.filter(m => [203, 134, 71, 94].includes(m.leagueId))
    : currentMatches.filter(m => m.leagueId === selectedLeague);

  // Filter by international selection
  const filteredInternationalMatches = selectedInternational === 'all'
    ? currentMatches.filter(m => [10, 667].includes(m.leagueId))
    : currentMatches.filter(m => m.leagueId === selectedInternational);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* Header - Live/Upcoming Selection */}
      <header className="bg-gradient-to-r from-gray-800 to-gray-900 border-b border-gray-700 p-4">
        <div className="max-w-7xl mx-auto flex justify-between items-center mb-4">
          <button
            onClick={() => setSelectedMatch(null)}
            className="hover:opacity-80 transition"
          >
            <h1 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-green-400 to-blue-500">
              🐰 SportyRabbi
            </h1>
          </button>
          <div className={`text-sm font-semibold ${connected ? 'text-green-400' : 'text-red-400'}`}>
            {connected ? '🟢 Live' : '🔴 Offline'} · Connected
          </div>
        </div>

        {/* Primary Tabs: Live / Upcoming */}
        <div className="max-w-7xl mx-auto border-b border-gray-700 pb-4 mb-4">
          <div className="flex gap-3">
            <button
              onClick={() => setActiveTab('live')}
              className={`font-bold text-lg px-8 py-3 rounded-lg transition ${
                activeTab === 'live'
                  ? 'bg-red-600 text-white shadow-lg border-b-4 border-red-400'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              🔴 LIVE NOW
            </button>
            <button
              onClick={() => setActiveTab('upcoming')}
              className={`font-bold text-lg px-8 py-3 rounded-lg transition ${
                activeTab === 'upcoming'
                  ? 'bg-blue-600 text-white shadow-lg border-b-4 border-blue-400'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              ⏰ UPCOMING
            </button>
          </div>
        </div>

        {/* Secondary Tabs: Leagues / International + Dropdowns */}
        <div className="max-w-7xl mx-auto">
          <div className="flex gap-3 items-center flex-wrap">
            {/* Leagues Tab */}
            <button
              onClick={() => setSubTab('leagues')}
              className={`font-semibold px-6 py-2 rounded-lg transition ${
                subTab === 'leagues'
                  ? 'bg-green-600 text-white shadow-lg'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              📺 Leagues
            </button>

            {/* League Dropdown */}
            {subTab === 'leagues' && (
              <select
                value={selectedLeague}
                onChange={(e) => setSelectedLeague(e.target.value)}
                className="bg-gray-700 text-white px-4 py-2 rounded-lg border border-gray-600 focus:border-green-500 focus:outline-none"
              >
                {leagueOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>
                    {opt.emoji} {opt.name}
                  </option>
                ))}
              </select>
            )}

            {/* International Tab */}
            <button
              onClick={() => setSubTab('international')}
              className={`font-semibold px-6 py-2 rounded-lg transition ${
                subTab === 'international'
                  ? 'bg-purple-600 text-white shadow-lg'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              🌍 International
            </button>

            {/* International Dropdown */}
            {subTab === 'international' && (
              <select
                value={selectedInternational}
                onChange={(e) => setSelectedInternational(e.target.value)}
                className="bg-gray-700 text-white px-4 py-2 rounded-lg border border-gray-600 focus:border-purple-500 focus:outline-none"
              >
                {internationalOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>
                    {opt.emoji} {opt.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {/* Main Content - Filtered Matches */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Filtered Matches */}
          <div className="lg:col-span-2 space-y-6">
            {/* Leagues Sub-Tab Content */}
            {subTab === 'leagues' && (
              <>
                {filteredLeagueMatches.length > 0 ? (
                  <div>
                    <h2 className="text-2xl font-bold mb-4">
                      {activeTab === 'live' ? '🔴 Live Matches' : '⏰ Upcoming Matches'}
                    </h2>
                    <p className="text-gray-400 text-sm mb-4">
                      {selectedLeague === 'all' ? 'All Leagues' : leagueOptions.find(l => l.id === selectedLeague)?.name}
                      {' '} ({filteredLeagueMatches.length})
                    </p>
                    <div className="space-y-2">
                      {filteredLeagueMatches.map((match) => (
                        <div
                          key={match.id}
                          onClick={() => setSelectedMatch(match)}
                          className="card cursor-pointer hover:bg-gray-700 transition"
                        >
                          <MatchCard
                            match={match}
                            onSelectMatch={() => setSelectedMatch(match)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="card text-center py-8">
                    <p className="text-gray-400">
                      {activeTab === 'live'
                        ? 'No live league matches at this time'
                        : 'No upcoming league matches scheduled'}
                    </p>
                  </div>
                )}
              </>
            )}

            {/* International Sub-Tab Content */}
            {subTab === 'international' && (
              <>
                {filteredInternationalMatches.length > 0 ? (
                  <div>
                    <h2 className="text-2xl font-bold mb-4">
                      {activeTab === 'live' ? '🔴 Live International' : '⏰ Upcoming International'}
                    </h2>
                    <p className="text-gray-400 text-sm mb-4">
                      {selectedInternational === 'all' ? 'All International' : internationalOptions.find(i => i.id === selectedInternational)?.name}
                      {' '} ({filteredInternationalMatches.length})
                    </p>
                    <div className="space-y-2">
                      {filteredInternationalMatches.map((match) => (
                        <div
                          key={match.id}
                          onClick={() => setSelectedMatch(match)}
                          className="card cursor-pointer hover:bg-gray-700 transition"
                        >
                          <MatchCard
                            match={match}
                            onSelectMatch={() => setSelectedMatch(match)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="card text-center py-8">
                    <p className="text-gray-400">
                      {activeTab === 'live'
                        ? 'No live international matches at this time'
                        : 'No upcoming international matches scheduled'}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right Column - Sidebar with Match Details */}
          <div className="space-y-6">
            {selectedMatch && (
              <div>
                <button
                  onClick={() => setSelectedMatch(null)}
                  className="mb-4 bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded transition"
                >
                  ← Back to Matches
                </button>
                <div className="card">
                  <h3 className="text-xl font-bold mb-4">{selectedMatch.home} vs {selectedMatch.away}</h3>
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-gray-400">League</p>
                      <p className="text-green-400">{selectedMatch.league}</p>
                    </div>
                    <div>
                      <p className="text-gray-400">Status</p>
                      <p className="text-blue-400">{selectedMatch.status}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-gray-400">Possession</p>
                        <p>{selectedMatch.possession?.home || 0}% - {selectedMatch.possession?.away || 0}%</p>
                      </div>
                      <div>
                        <p className="text-gray-400">Shots</p>
                        <p>{selectedMatch.shots?.home || 0} - {selectedMatch.shots?.away || 0}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Bet Logger */}
            <div>
              <h3 className="text-lg font-bold mb-3">📝 Log Bet</h3>
              <BetLogger onBetLogged={(bet) => console.log('Bet logged:', bet)} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

