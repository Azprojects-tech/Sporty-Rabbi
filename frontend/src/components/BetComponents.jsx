import React, { useState } from 'react';
import { apiService } from '../services/api';

export function BetLogger() {
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    matchName: '',
    betType: 'home_win',
    selection: '',
    odds: '',
    stake: '',
    confidence: '',
    closingOdds: '',
    leagueName: '',
    paper: false,
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    if (type === 'checkbox') {
      setFormData((prev) => ({ ...prev, [name]: checked }));
      return;
    }
    const numericFields = ['odds', 'stake', 'confidence', 'closingOdds'];
    setFormData((prev) => ({
      ...prev,
      [name]: numericFields.includes(name) ? parseFloat(value) || '' : value,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Stake and the SportyBet price are what make a bet record useful for P&L.
    if (!(Number(formData.stake) > 0)) { setMessage('❌ Enter the stake you placed (₦).'); return; }
    if (!(Number(formData.odds) > 1)) { setMessage('❌ Enter the SportyBet odds (greater than 1.00).'); return; }
    setLoading(true);

    try {
      await apiService.logBet({ ...formData, bookmaker: 'SportyBet' });
      setMessage(formData.paper ? '✓ Practice bet logged (not counted in real profit/loss).' : '✓ Bet logged!');
      setFormData({
        matchName: '',
        betType: 'home_win',
        selection: '',
        odds: '',
        stake: '',
        confidence: '',
        closingOdds: '',
        leagueName: '',
        paper: false,
      });
      setTimeout(() => {
        setShowForm(false);
        setMessage('');
      }, 2000);
    } catch (error) {
      setMessage('❌ ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <h3 className="text-lg font-bold mb-4">📊 Log Bet</h3>

      {!showForm ? (
        <button onClick={() => setShowForm(true)} className="btn btn-primary w-full">
          + New Bet
        </button>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            name="matchName"
            placeholder="Match (e.g., Man City vs Liverpool)"
            value={formData.matchName}
            onChange={handleChange}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 w-full text-sm"
            required
          />

          <select
            name="betType"
            value={formData.betType}
            onChange={handleChange}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 w-full text-sm"
          >
            <option value="home_win">Home Win</option>
            <option value="away_win">Away Win</option>
            <option value="draw">Draw</option>
            <option value="over">Over 1.5 Goals</option>
            <option value="under">Under 2.5 Goals</option>
            <option value="btts">Both Teams to Score</option>
          </select>

          <input
            type="text"
            name="selection"
            placeholder="Selection details"
            value={formData.selection}
            onChange={handleChange}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 w-full text-sm"
          />

          <input
            type="text"
            name="leagueName"
            placeholder="League (e.g., Premier League)"
            value={formData.leagueName}
            onChange={handleChange}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 w-full text-sm"
          />

          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              name="odds"
              placeholder="SportyBet odds"
              aria-label="SportyBet odds"
              step="0.01"
              min="1.01"
              value={formData.odds}
              onChange={handleChange}
              className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm"
              required
            />
            <input
              type="number"
              name="stake"
              placeholder="Stake (₦)"
              aria-label="Stake in naira"
              step="0.01"
              min="1"
              value={formData.stake}
              onChange={handleChange}
              className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm"
              required
            />
          </div>

          <input
            type="number"
            name="confidence"
            placeholder="Model confidence % (optional)"
            min="1"
            max="100"
            value={formData.confidence}
            onChange={handleChange}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 w-full text-sm"
          />

          <input
            type="number"
            name="closingOdds"
            placeholder="Closing odds (optional, for CLV tracking)"
            step="0.01"
            min="1"
            value={formData.closingOdds}
            onChange={handleChange}
            className="bg-gray-700 border border-gray-600 rounded px-3 py-2 w-full text-sm"
          />

          <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" name="paper" checked={formData.paper} onChange={handleChange} />
            Practice bet (no real money — kept out of real profit/loss)
          </label>

          {message && <p className={`text-sm ${message.includes('✓') ? 'text-green-400' : 'text-red-400'}`}>{message}</p>}

          <div className="flex gap-2">
            <button type="submit" disabled={loading} className="btn btn-primary flex-1">
              {loading ? '...' : '✓ Log'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary flex-1">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function BetStats({ stats }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="card">
        <p className="text-gray-400 text-sm mb-2">Total Bets</p>
        <p className="text-3xl font-bold text-green-400">{stats.totalBets}</p>
      </div>
      <div className="card">
        <p className="text-gray-400 text-sm mb-2">Win Rate</p>
        <p className="text-3xl font-bold text-green-400">{stats.winRate}</p>
      </div>
      <div className="card">
        <p className="text-gray-400 text-sm mb-2">Wins</p>
        <p className="text-2xl font-bold text-green-400">{stats.wins}</p>
      </div>
      <div className="card">
        <p className="text-gray-400 text-sm mb-2">Losses</p>
        <p className="text-2xl font-bold text-red-400">{stats.losses}</p>
      </div>
    </div>
  );
}
