import React, { useState, useEffect } from 'react';
import { AlertCircle, Zap } from 'lucide-react';
import { connectWebSocket, on, apiService } from './services/api';
import { MatchCard, ConfidenceScore, Alert } from './components/MatchComponents';
import { BetLogger, BetStats } from './components/BetComponents';
import AnalyticsModal from './components/AnalyticsModal';

export default function App() {
  const [matches, setMatches] = useState([]);
  const [bets, setBets] = useState([]);
  const [stats, setStats] = useState(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('live');
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
      setMatches(payload || []);
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

    // Fetch initial data
    const fetchData = async () => {
      try {
        const [betsRes, statsRes] = await Promise.all([
          apiService.getBets(),
          apiService.getStats(),
        ]);
        setBets(betsRes.data.bets || []);
        setStats(statsRes.data);
      } catch (err) {
        console.error('Error fetching data:', err);
      }
    };

    fetchData();
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* Header */}
      <header className="bg-gradient-to-r from-gray-800 to-gray-900 border-b border-gray-700 p-6">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-green-400 to-blue-500">
              🐰 SportyRabbi
            </h1>
            <p className="text-gray-400 mt-2">Smart Football Betting Analytics</p>
          </div>
          <div className="text-right">
            <div className={`text-sm font-semibold ${connected ? 'text-green-400' : 'text-red-400'}`}>
              {connected ? '🟢 Live' : '🔴 Offline'}
            </div>
            <div className="text-xs text-gray-400">{matches.length} live matches</div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {/* Navigation Tabs */}
        <div className="flex gap-4 mb-6 border-b border-gray-700 pb-4">
          {['live', 'tracking', 'alerts'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`capitalize font-semibold transition-colors ${
                activeTab === tab
                  ? 'text-green-400 border-b-2 border-green-400'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              {tab === 'live' && '🔴 Live Matches'}
              {tab === 'tracking' && '📈 My Bets'}
              {tab === 'alerts' && '⚡ Opportunities'}
            </button>
          ))}
        </div>

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Matches/Content */}
          <div className="lg:col-span-2">
            {activeTab === 'live' && (
              <div>
                <h2 className="text-2xl font-bold mb-4">🔴 Live Matches</h2>
                {!connected && (
                  <div className="card bg-yellow-900 border-yellow-600 mb-4">
                    <p className="text-yellow-200">⚠️ Connecting to live feed...</p>
                  </div>
                )}
                {matches.length === 0 ? (
                  <div className="card">
                    <p className="text-gray-400">No live matches right now</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {matches.map((match) => (
                      <MatchCard
                        key={match.id}
                        match={match}
                        onSelectMatch={() => setSelectedMatch(match)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'tracking' && (
              <div>
                <h2 className="text-2xl font-bold mb-4">📈 Betting Performance</h2>
                {stats && <BetStats stats={stats} />}
              </div>
            )}

            {activeTab === 'alerts' && (
              <div>
                <h2 className="text-2xl font-bold mb-4">⚡ Betting Opportunities</h2>
                {matches
                  .filter((m) => m.confidence > 65)
                  .map((match) => (
                    <Alert
                      key={match.id}
                      match={match}
                      alert={{
                        title: `${match.home} vs ${match.away}`,
                        description: `Confidence: ${match.confidence}% | Possession: ${match.possession.home}%`,
                        confidence_score: match.confidence,
                        recommended_bet: match.opportunities[0] || 'Back to Win',
                      }}
                    />
                  ))}
              </div>
            )}
          </div>

          {/* Right Column - Sidebar */}
          <div className="space-y-6">
            {/* Bet Logger */}
            <BetLogger />

            {/* Quick Stats */}
            {stats && (
              <div className="card">
                <h3 className="font-bold mb-4">📊 Your Stats</h3>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Total Bets:</span>
                    <span className="font-bold">{stats.totalBets}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Win Rate:</span>
                    <span className={`font-bold ${stats.winRate > '50%' ? 'text-green-400' : 'text-red-400'}`}>
                      {stats.winRate}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Wins / Losses:</span>
                    <span className="font-bold">
                      {stats.wins} / {stats.losses}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Connection Status */}
            <div className={`card border-2 ${connected ? 'border-green-600 bg-green-900' : 'border-red-600 bg-red-900'}`}>
              <p className="font-bold mb-2">{connected ? '✓ System Status' : '⚠️ Connection Lost'}</p>
              <p className="text-sm text-gray-300">
                {connected ? 'Portal and backend are synced. Live data flowing.' : 'Attempting to reconnect...'}
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Analytics Modal */}
      {selectedMatch && (
        <AnalyticsModal
          match={selectedMatch}
          onClose={() => setSelectedMatch(null)}
        />
      )}
    </div>
  );
}

