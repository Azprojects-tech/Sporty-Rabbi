import React, { useState, useEffect } from 'react';
import api from '../services/api';

export default function LiveAnalysisPanel({ match }) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showOddsInput, setShowOddsInput] = useState(false);

  useEffect(() => {
    if (!match || match.status !== 'LIVE') {
      setLoading(false);
      return;
    }

    const fetchAnalysis = async () => {
      try {
        const response = await api.get(`/live-analysis/${match.id}`);
        setAnalysis(response.data);
      } catch (error) {
        console.error('Error fetching live analysis:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchAnalysis();
    const interval = setInterval(fetchAnalysis, 10000); // Update every 10s during live play

    return () => clearInterval(interval);
  }, [match]);

  if (!match || match.status !== 'LIVE') {
    return null;
  }

  if (loading) {
    return (
      <div className="card bg-gray-800 border-purple-500/20 animate-pulse">
        <p className="text-gray-400">Loading live analysis...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Next Goal Predictor */}
      {analysis?.nextGoal && <NextGoalPredictor nextGoal={analysis.nextGoal} match={match} />}

      {/* Momentum Meter */}
      {analysis?.momentum && <MomentumMeter momentum={analysis.momentum} match={match} />}

      {/* Goal Pace Tracker */}
      {analysis?.goalPace && <GoalPaceTracker goalPace={analysis.goalPace} />}

      {/* Betting Alerts */}
      {analysis?.alerts && analysis.alerts.length > 0 && (
        <BettingAlerts alerts={analysis.alerts} />
      )}

      {/* Odds Input */}
      <button
        onClick={() => setShowOddsInput(!showOddsInput)}
        className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded transition"
      >
        {showOddsInput ? '✓ Close' : '💰 Check Bet Value'} (Enter SportyBet Odds)
      </button>

      {showOddsInput && (
        <OddsInputForm match={match} nextGoal={analysis?.nextGoal} momentum={analysis?.momentum} />
      )}
    </div>
  );
}

function NextGoalPredictor({ nextGoal, match }) {
  const homeProb = nextGoal.home.probability || 0;
  const awayProb = nextGoal.away.probability || 0;
  const maxProb = Math.max(homeProb, awayProb);

  return (
    <div className="card bg-gradient-to-br from-blue-900/30 to-blue-900/10 border-blue-500/30">
      <h3 className="font-bold mb-4 text-blue-300">🎯 Next Goal Probability</h3>

      <div className="space-y-3">
        {/* Home Team */}
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-sm font-semibold">{match.home}</span>
            <span className="text-sm font-bold text-blue-300">{homeProb}%</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-3">
            <div
              className="h-3 rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500"
              style={{ width: `${homeProb}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">{nextGoal.home.reasoning}</p>
        </div>

        {/* Away Team */}
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-sm font-semibold">{match.away}</span>
            <span className="text-sm font-bold text-sky-300">{awayProb}%</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-3">
            <div
              className="h-3 rounded-full bg-gradient-to-r from-sky-500 to-sky-400 transition-all duration-500"
              style={{ width: `${awayProb}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">{nextGoal.away.reasoning}</p>
        </div>
      </div>

      {maxProb > 50 && (
        <div className="mt-3 p-2 bg-yellow-900/40 border border-yellow-500/40 rounded text-xs text-yellow-300">
          ⚡ High probability incoming - <strong>watch for goals soon!</strong>
        </div>
      )}
    </div>
  );
}

function MomentumMeter({ momentum, match }) {
  const homeMom = momentum.home.momentum;
  const awayMom = momentum.away.momentum;

  return (
    <div className="card bg-gradient-to-br from-purple-900/30 to-purple-900/10 border-purple-500/30">
      <h3 className="font-bold mb-4 text-purple-300">⚙️ Momentum Meter</h3>

      {/* Main Momentum Bar */}
      <div className="space-y-3 mb-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold w-24">{match.home}</span>
          <div className="flex-1 relative h-4 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="absolute h-full bg-gradient-to-r from-purple-600 to-purple-400 transition-all duration-500"
              style={{ width: `${homeMom}%` }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs font-bold text-white">{homeMom}%</span>
            </div>
          </div>
          <span className="text-xs font-semibold text-right w-24">{awayMom}%</span>
        </div>
        <div className="text-right">
          <span className="text-xs font-bold">{match.away}</span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 text-xs mb-4">
        <div className="bg-gray-800/50 rounded p-2">
          <p className="text-gray-400">Possession</p>
          <p className="font-bold">{momentum.home.possession}% | {momentum.away.possession}%</p>
        </div>
        <div className="bg-gray-800/50 rounded p-2">
          <p className="text-gray-400">Shots</p>
          <p className="font-bold">{momentum.home.shots} | {momentum.away.shots}</p>
        </div>
        <div className="bg-gray-800/50 rounded p-2">
          <p className="text-gray-400">Expected Goals</p>
          <p className="font-bold">{momentum.home.xg} | {momentum.away.xg}</p>
        </div>
        <div className="bg-gray-800/50 rounded p-2">
          <p className="text-gray-400">Danger Level</p>
          <p className={`font-bold ${momentum.home.dangerLevel === 'HIGH' ? 'text-red-400' : 'text-yellow-400'}`}>
            {momentum.home.dangerLevel} | {momentum.away.dangerLevel}
          </p>
        </div>
      </div>

      {/* Insight */}
      <div className={`p-2 rounded text-xs ${
        momentum.trend.includes('surging')
          ? 'bg-red-900/40 border border-red-500/40 text-red-300'
          : 'bg-blue-900/40 border border-blue-500/40 text-blue-300'
      }`}>
        {momentum.insight}
      </div>
    </div>
  );
}

function GoalPaceTracker({ goalPace }) {
  const over25 = goalPace.over25Likely;
  const over15 = goalPace.over15Likely;

  return (
    <div className="card bg-gradient-to-br from-orange-900/30 to-orange-900/10 border-orange-500/30">
      <h3 className="font-bold mb-3 text-orange-300">⏱️ Goal Pace Analysis</h3>

      <div className="grid grid-cols-2 gap-3 text-sm mb-3">
        <div className="bg-gray-800/50 rounded p-3">
          <p className="text-gray-400 text-xs">Current Rate</p>
          <p className="font-bold text-lg">{goalPace.currentGoalRate}</p>
          <p className="text-xs text-gray-400">goals/min</p>
        </div>
        <div className="bg-gray-800/50 rounded p-3">
          <p className="text-gray-400 text-xs">Projected Final</p>
          <p className="font-bold text-lg">{goalPace.projectedFinalGoals}</p>
          <p className="text-xs text-gray-400">total goals</p>
        </div>
      </div>

      {/* Over/Under Indicators */}
      <div className="space-y-2">
        {over25 && (
          <div className="bg-green-900/40 border border-green-500/40 rounded p-2 text-xs text-green-300">
            ✅ <strong>OVER 2.5</strong> goals likely (trending high)
          </div>
        )}
        {!over25 && over15 && (
          <div className="bg-yellow-900/40 border border-yellow-500/40 rounded p-2 text-xs text-yellow-300">
            ⚠️ <strong>OVER 1.5</strong> goals likely
          </div>
        )}
        {!over15 && (
          <div className="bg-blue-900/40 border border-blue-500/40 rounded p-2 text-xs text-blue-300">
            ℹ️ Low pace - trends <strong>UNDER 1.5</strong>
          </div>
        )}
      </div>
    </div>
  );
}

function BettingAlerts({ alerts }) {
  const highPriorityAlerts = alerts.filter((a) => a.urgency === 'HIGH');

  if (highPriorityAlerts.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {highPriorityAlerts.map((alert, i) => (
        <div
          key={i}
          className="bg-red-900/50 border border-red-500/50 rounded p-3 text-sm text-red-200"
        >
          <p className="font-bold">🚨 HIGH PRIORITY</p>
          <p>{alert.message}</p>
        </div>
      ))}
    </div>
  );
}

function OddsInputForm({ match, nextGoal, momentum }) {
  const [selectedBet, setSelectedBet] = useState('nextGoal');
  const [odds, setOdds] = useState('');
  const [valueResult, setValueResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleCheckValue = async () => {
    if (!odds || !selectedBet) return;

    setLoading(true);
    try {
      let probability = 0;

      if (selectedBet === 'nextGoal-home') {
        probability = nextGoal?.home.probability || 0;
      } else if (selectedBet === 'nextGoal-away') {
        probability = nextGoal?.away.probability || 0;
      } else if (selectedBet === 'over25') {
        // Over 2.5 calculation
        probability = (parseFloat(nextGoal?.homeGoalRate || 0) * 45) * 100; // Simplified
      }

      const response = await api.post('/bet-value', {
        probability,
        odds: parseFloat(odds),
      });

      setValueResult(response.data);
    } catch (error) {
      console.error('Error checking bet value:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card bg-gray-800 border-green-500/30 space-y-3">
      <p className="text-sm text-gray-300">
        Enter SportyBet odds to check if they offer value against calculated probability
      </p>

      {/* Bet Selection */}
      <select
        value={selectedBet}
        onChange={(e) => setSelectedBet(e.target.value)}
        className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm"
      >
        <option value="nextGoal-home">{match.home} - Next Goal ({nextGoal?.home.probability || 0}%)</option>
        <option value="nextGoal-away">{match.away} - Next Goal ({nextGoal?.away.probability || 0}%)</option>
        <option value="over25">Over 2.5 Goals</option>
        <option value="over15">Over 1.5 Goals</option>
      </select>

      {/* Odds Input */}
      <div className="flex gap-2">
        <input
          type="number"
          step="0.01"
          min="1"
          placeholder="Enter decimal odds (e.g., 3.50)"
          value={odds}
          onChange={(e) => setOdds(e.target.value)}
          className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white text-sm"
        />
        <button
          onClick={handleCheckValue}
          disabled={loading || !odds}
          className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white font-bold px-4 py-2 rounded text-sm transition"
        >
          {loading ? '...' : 'Check'}
        </button>
      </div>

      {/* Value Result */}
      {valueResult && (
        <div
          className={`p-3 rounded text-sm border ${
            valueResult.hasValue
              ? 'bg-green-900/40 border-green-500/40 text-green-300'
              : 'bg-red-900/40 border-red-500/40 text-red-300'
          }`}
        >
          <p className="font-bold mb-1">{valueResult.hasValue ? '✅ VALUE FOUND!' : '❌ No Value'}</p>
          <p className="text-xs mb-2">{valueResult.recommendation}</p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-gray-300">Your Odds</p>
              <p className="font-bold">{parseFloat(odds).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-gray-300">Fair Odds</p>
              <p className="font-bold">{(1 / (valueResult.calculatedProbability / 100)).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-gray-300">Expected Value</p>
              <p className="font-bold">{valueResult.expectedValuePercent}%</p>
            </div>
            <div>
              <p className="text-gray-300">Implied Prob</p>
              <p className="font-bold">{valueResult.impliedProbability}%</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
