import React from 'react';
import { AlertCircle } from 'lucide-react';

export function MatchCard({ match, onSelectMatch }) {
  return (
    <div className="card-hover cursor-pointer">
      <div className="flex justify-between items-start mb-4">
        <span className="text-xs font-bold text-green-400 bg-green-900 px-2 py-1 rounded">
          {match.status || 'LIVE'}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSelectMatch(match);
          }}
          className="text-xs font-bold text-purple-400 bg-purple-900/40 hover:bg-purple-900 border border-purple-500 px-3 py-1 rounded transition"
        >
          📊 Stats
        </button>
      </div>

      {/* Score */}
      <div className="text-center mb-4">
        <div className="flex justify-between items-center">
          <div className="flex-1">
            <p className="font-bold text-lg">{match.home}</p>
            <p className="text-2xl font-bold text-green-400">{match.score?.split('-')[0] || 0}</p>
          </div>
          <div className="mx-4 text-gray-500">vs</div>
          <div className="flex-1 text-right">
            <p className="font-bold text-lg">{match.away}</p>
            <p className="text-2xl font-bold text-green-400">{match.score?.split('-')[1] || 0}</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 text-xs mb-4 border-t border-gray-700 pt-4">
        <div>
          <p className="text-gray-400">Possession</p>
          <p className="font-bold">{match.possession?.home || 0}%</p>
        </div>
        <div>
          <p className="text-gray-400">Shots</p>
          <p className="font-bold">
            {match.shots?.home || 0} vs {match.shots?.away || 0}
          </p>
        </div>
        <div>
          <p className="text-gray-400">xG</p>
          <p className="font-bold">
            {(match.xg?.home || 0).toFixed(1)} vs {(match.xg?.away || 0).toFixed(1)}
          </p>
        </div>
      </div>

      {/* Confidence */}
      <ConfidenceScore score={match.confidence} />
    </div>
  );
}

export function ConfidenceScore({ score }) {
  let color = 'text-red-400';
  if (score >= 70) color = 'text-green-400';
  else if (score >= 60) color = 'text-yellow-400';

  return (
    <div className="flex items-center gap-2">
      <div className="w-full bg-gray-700 rounded-full h-2">
        <div
          className={`h-2 rounded-full ${
            score >= 70 ? 'bg-green-500' : score >= 60 ? 'bg-yellow-500' : 'bg-red-500'
          }`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className={`${color} font-bold text-sm`}>{score.toFixed(0)}%</span>
    </div>
  );
}

export function Alert({ match, alert }) {
  return (
    <div className="bg-gradient-to-r from-yellow-900 to-orange-900 border border-yellow-600 rounded-lg p-4 mb-3">
      <div className="flex gap-3">
        <AlertCircle className="text-yellow-400 flex-shrink-0 mt-1" size={20} />
        <div className="flex-1">
          <h4 className="font-bold text-yellow-300 mb-1">{alert.title}</h4>
          <p className="text-sm text-gray-200 mb-2">{alert.description}</p>
          <div className="flex justify-between items-center">
            <ConfidenceScore score={alert.confidence_score} />
            <button className="btn btn-primary btn-sm">
              💡 {alert.recommended_bet}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
