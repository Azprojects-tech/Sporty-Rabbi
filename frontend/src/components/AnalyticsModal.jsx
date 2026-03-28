import React, { useState, useEffect } from 'react';
import { apiService } from '../services/api';

export default function AnalyticsModal({ match, onClose }) {
  const [activeTab, setActiveTab] = useState('home');
  const [homeForm, setHomeForm] = useState(null);
  const [awayForm, setAwayForm] = useState(null);
  const [h2h, setH2H] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadAnalytics();
  }, [match]);

  const loadAnalytics = async () => {
    setLoading(true);
    setError(null);
    try {
      // We need team IDs, which should be in match data
      // If not available, we'll show a message
      if (!match.homeTeamId || !match.awayTeamId) {
        console.warn('Team IDs not available in match data');
        // Try using the names as fallback or show error
        setError('Team ID data not yet available. Please refresh.');
        setLoading(false);
        return;
      }

      const [homeData, awayData, h2hData] = await Promise.all([
        apiService.client.get(`/analytics/team-form/${match.homeTeamId}`).catch(e => {
          console.error('Home form error:', e);
          return { data: { success: false } };
        }),
        apiService.client.get(`/analytics/team-form/${match.awayTeamId}`).catch(e => {
          console.error('Away form error:', e);
          return { data: { success: false } };
        }),
        apiService.client.get(`/analytics/h2h/${match.homeTeamId}/${match.awayTeamId}`).catch(e => {
          console.error('H2H error:', e);
          return { data: { success: false } };
        }),
      ]);

      if (homeData.data?.success) setHomeForm(homeData.data.data);
      if (awayData.data?.success) setAwayForm(awayData.data.data);
      if (h2hData.data?.success) setH2H(h2hData.data.data);

      if (!homeData.data?.success && !awayData.data?.success && !h2hData.data?.success) {
        setError('Could not load team statistics. API data may not be available yet.');
      }
    } catch (err) {
      console.error('Analytics error:', err);
      setError('Could not load team statistics');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-gray-900 rounded-lg p-6 text-center">
          <div className="animate-spin h-8 w-8 border-4 border-purple-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-gray-300">Loading team statistics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto border border-purple-500/30">
        {/* Header */}
        <div className="sticky top-0 bg-gray-900 border-b border-purple-500/30 p-4 flex justify-between items-center">
          <h2 className="text-xl font-bold text-white">
            {match.home} vs {match.away} - Analytics
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 text-2xl font-bold"
          >
            ×
          </button>
        </div>

        {error && (
          <div className="p-4 bg-yellow-500/20 border-b border-yellow-500/30 text-yellow-300">
            ⚠️ {error}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-purple-500/20 bg-gray-800/50">
          <button
            onClick={() => setActiveTab('home')}
            className={`flex-1 px-4 py-3 font-semibold transition ${
              activeTab === 'home'
                ? 'text-purple-400 border-b-2 border-purple-500'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            {match.home} Form
          </button>
          <button
            onClick={() => setActiveTab('away')}
            className={`flex-1 px-4 py-3 font-semibold transition ${
              activeTab === 'away'
                ? 'text-purple-400 border-b-2 border-purple-500'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            {match.away} Form
          </button>
          <button
            onClick={() => setActiveTab('h2h')}
            className={`flex-1 px-4 py-3 font-semibold transition ${
              activeTab === 'h2h'
                ? 'text-purple-400 border-b-2 border-purple-500'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            H2H History
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {activeTab === 'home' && homeForm ? <TeamStats team={homeForm} /> : activeTab === 'home' && <div className="text-gray-400">No data available</div>}
          {activeTab === 'away' && awayForm ? <TeamStats team={awayForm} /> : activeTab === 'away' && <div className="text-gray-400">No data available</div>}
          {activeTab === 'h2h' && h2h ? <H2HStats h2h={h2h} /> : activeTab === 'h2h' && <div className="text-gray-400">No head-to-head data available</div>}
        </div>
      </div>
    </div>
  );
}

function TeamStats({ team }) {
  if (team?.error) {
    return <p className="text-gray-400">Could not load team data</p>;
  }

  const stats = team?.stats || {};
  const matches = team?.matches || [];

  return (
    <div className="space-y-6">
      {/* Stats Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-green-500/10 border border-green-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Wins</p>
          <p className="text-2xl font-bold text-green-400">{stats.wins || 0}</p>
        </div>
        <div className="bg-gray-500/10 border border-gray-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Draws</p>
          <p className="text-2xl font-bold text-gray-300">{stats.draws || 0}</p>
        </div>
        <div className="bg-red-500/10 border border-red-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Losses</p>
          <p className="text-2xl font-bold text-red-400">{stats.losses || 0}</p>
        </div>
        <div className="bg-blue-500/10 border border-blue-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Win Rate</p>
          <p className="text-2xl font-bold text-blue-400">{stats.winRate || '0'}%</p>
        </div>
      </div>

      {/* Goal Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-purple-500/10 border border-purple-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Goals For (Avg)</p>
          <p className="text-2xl font-bold text-purple-300">
            {stats.goalsFor} ({(stats.avgGoalsFor || 0).toFixed(1)})
          </p>
        </div>
        <div className="bg-red-500/10 border border-red-500/30 rounded p-4">
          <p className="text-gray-400 text-sm">Goals Against (Avg)</p>
          <p className="text-2xl font-bold text-red-300">
            {stats.goalsAgainst} ({(stats.avgGoalsAgainst || 0).toFixed(1)})
          </p>
        </div>
      </div>

      {/* Form String */}
      {stats.form && (
        <div>
          <p className="text-gray-400 text-sm mb-2">Recent Form (Last 10)</p>
          <div className="flex gap-2">
            {stats.form.split('').map((result, idx) => (
              <div
                key={idx}
                className={`w-8 h-8 flex items-center justify-center rounded font-bold text-white ${
                  result === 'W'
                    ? 'bg-green-600'
                    : result === 'D'
                    ? 'bg-gray-600'
                    : 'bg-red-600'
                }`}
              >
                {result}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function H2HStats({ h2h }) {
  if (h2h.stats?.error) {
    return <p className="text-gray-400">Could not load H2H data</p>;
  }

  const stats = h2h.stats || {};
  const matches = h2h.matches || [];

  return (
    <div className="space-y-6">
      {/* H2H Record */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-blue-500/10 border border-blue-500/30 rounded p-4 text-center">
          <p className="text-gray-400 text-sm">{h2h.teamAName || 'Team A'} Wins</p>
          <p className="text-3xl font-bold text-blue-400">{stats.teamAWins || 0}</p>
        </div>
        <div className="bg-gray-500/10 border border-gray-500/30 rounded p-4 text-center">
          <p className="text-gray-400 text-sm">Draws</p>
          <p className="text-3xl font-bold text-gray-300">{stats.draws || 0}</p>
        </div>
        <div className="bg-orange-500/10 border border-orange-500/30 rounded p-4 text-center">
          <p className="text-gray-400 text-sm">{h2h.teamBName || 'Team B'} Wins</p>
          <p className="text-3xl font-bold text-orange-400">{stats.teamBWins || 0}</p>
        </div>
      </div>

      {/* Goal Stats */}
      <div className="bg-purple-500/10 border border-purple-500/30 rounded p-4">
        <p className="text-gray-400 text-sm mb-2">Total Goals</p>
        <p className="text-2xl font-bold text-purple-300 mb-1">
          {stats.totalGoals || 0} goals in {matches.length} meetings
        </p>
        <p className="text-gray-400 text-sm">
          Average: {stats.avgGoalsPerMatch || 0} goals per match
        </p>
      </div>

      {/* Previous Matches */}
      {matches.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-800">
              <tr>
                <th className="px-4 py-2 text-left text-gray-400">Date</th>
                <th className="px-4 py-2 text-left text-gray-400">Home</th>
                <th className="px-4 py-2 text-center text-gray-400">Score</th>
                <th className="px-4 py-2 text-left text-gray-400">Away</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((match, i) => (
                <tr key={i} className="border-t border-gray-700 hover:bg-gray-800/50">
                  <td className="px-4 py-2 text-gray-400 text-xs">
                    {new Date(match.date).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 text-white">{match.home}</td>
                  <td className="px-4 py-2 text-center font-bold text-purple-300">
                    {match.homeGoals} - {match.awayGoals}
                  </td>
                  <td className="px-4 py-2 text-white">{match.away}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
