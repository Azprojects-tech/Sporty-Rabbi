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
  const [activeTab, setActiveTab] = useState('leagues');
  const [selectedMatch, setSelectedMatch] = useState(null);

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

  // Group matches by league
  const groupedMatches = {
    turkey: (upcomingMatches.length > 0 ? upcomingMatches : matches).filter(m => m.leagueId === 203),
    argentina: (upcomingMatches.length > 0 ? upcomingMatches : matches).filter(m => m.leagueId === 134),
    brazil: (upcomingMatches.length > 0 ? upcomingMatches : matches).filter(m => m.leagueId === 71),
    international: (upcomingMatches.length > 0 ? upcomingMatches : matches).filter(m => [667, 10].includes(m.leagueId)),
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* Header - Minimal, just connection status */}
      <header className="bg-gradient-to-r from-gray-800 to-gray-900 border-b border-gray-700 p-4">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
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

        {/* Tabs */}
        <div className="max-w-7xl mx-auto mt-4 flex gap-4">
          <button
            onClick={() => setActiveTab('leagues')}
            className={`font-semibold px-4 py-2 rounded transition ${
              activeTab === 'leagues'
                ? 'bg-green-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            📺 All Leagues
          </button>
          <button
            onClick={() => setActiveTab('international')}
            className={`font-semibold px-4 py-2 rounded transition ${
              activeTab === 'international'
                ? 'bg-green-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            🌍 International
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {/* Main Content - League Groupings */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Grouped Matches */}
          <div className="lg:col-span-2 space-y-6">
            {/* Leagues Tab */}
            {activeTab === 'leagues' && (
              <>
                {/* 🇹🇷 Turkey */}
                {groupedMatches.turkey.length > 0 && (
                  <div>
                    <h2 className="text-2xl font-bold mb-3">🇹🇷 Turkey ({groupedMatches.turkey.length})</h2>
                    <div className="space-y-2">
                      {groupedMatches.turkey.map((match) => (
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
                )}

                {/* 🇦🇷 Argentina */}
                {groupedMatches.argentina.length > 0 && (
                  <div>
                    <h2 className="text-2xl font-bold mb-3">🇦🇷 Argentina ({groupedMatches.argentina.length})</h2>
                    <div className="space-y-2">
                      {groupedMatches.argentina.map((match) => (
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
                )}

                {/* 🇧🇷 Brazil */}
                {groupedMatches.brazil.length > 0 && (
                  <div>
                    <h2 className="text-2xl font-bold mb-3">🇧🇷 Brazil ({groupedMatches.brazil.length})</h2>
                    <div className="space-y-2">
                      {groupedMatches.brazil.map((match) => (
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
                )}

                {/* Empty state */}
                {groupedMatches.turkey.length === 0 && groupedMatches.argentina.length === 0 && groupedMatches.brazil.length === 0 && (
                  <div className="card text-center py-8">
                    <p className="text-gray-400">No league matches available</p>
                  </div>
                )}
              </>
            )}

            {/* International Tab */}
            {activeTab === 'international' && (
              <>
                {/* 🌍 International */}
                {groupedMatches.international.length > 0 && (
                  <div>
                    <h2 className="text-2xl font-bold mb-3">🌍 International ({groupedMatches.international.length})</h2>
                    <div className="space-y-2">
                      {groupedMatches.international.map((match) => (
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
                )}

                {/* Empty state */}
                {groupedMatches.international.length === 0 && (
                  <div className="card text-center py-8">
                    <p className="text-gray-400">No international matches available</p>
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

