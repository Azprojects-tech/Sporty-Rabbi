import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../services/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-NG') : '—';
}

function timeStr(kickoffUTC) {
  if (!kickoffUTC) return '--:--';
  try {
    return new Date(kickoffUTC).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    });
  } catch { return '--:--'; }
}

function ConfBadge({ conf }) {
  const c = conf >= 90 ? '#00b859' : conf >= 80 ? '#fbbf24' : '#f97316';
  return (
    <span style={{
      background: c + '22', border: `1px solid ${c}55`, borderRadius: 3,
      padding: '1px 5px', fontSize: 10, fontWeight: 700, color: c,
    }}>
      {conf}%
    </span>
  );
}

function OddsBadge({ odds }) {
  return (
    <span style={{
      background: '#1e2535', borderRadius: 3,
      padding: '1px 6px', fontSize: 11, fontWeight: 800, color: '#e2e8f0',
    }}>
      {odds}
    </span>
  );
}

// ─── Leg row ──────────────────────────────────────────────────────────────────

function LegRow({ leg, index }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '7px 0', borderBottom: '1px solid #1e2535',
    }}>
      <span style={{ fontSize: 10, color: '#4a5568', minWidth: 14, fontWeight: 700 }}>
        {index + 1}.
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>
          {leg.match}
        </div>
        <div style={{ fontSize: 10, color: '#4a5568', marginTop: 1 }}>
          {leg.league} · {timeStr(leg.kickoffUTC)}
        </div>
        <div style={{ fontSize: 11, color: '#a78bfa', marginTop: 2, fontWeight: 600 }}>
          {leg.selection}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <OddsBadge odds={leg.odds} />
        <ConfBadge conf={leg.confidence} />
      </div>
    </div>
  );
}

// ─── Tier card ────────────────────────────────────────────────────────────────

const TIER_META = {
  1: { label: 'TIER 1', sub: 'Near-certain singles', color: '#00b859', bg: '#001a0e', icon: '🏆' },
  2: { label: 'TIER 2', sub: '2-3 leg accumulator', color: '#fbbf24', bg: '#1a1200', icon: '⚡' },
  3: { label: 'TIER 3', sub: 'Value combination',   color: '#f97316', bg: '#1a0a00', icon: '🎯' },
};

function TierCard({ tier, data, type = 'single' }) {
  const meta = TIER_META[tier];

  if (!data || (Array.isArray(data) && data.length === 0)) {
    return (
      <div style={{
        border: `1px solid ${meta.color}33`, borderRadius: 8,
        background: meta.bg, padding: '14px 16px', marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 16 }}>{meta.icon}</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: meta.color }}>{meta.label}</span>
          <span style={{ fontSize: 10, color: '#4a5568' }}>{meta.sub}</span>
        </div>
        <p style={{ fontSize: 11, color: '#4a5568' }}>
          No fixtures above {tier === 1 ? '85%' : tier === 2 ? '72%' : '65%'} confidence today. Best available picks shown in lower tiers.
        </p>
      </div>
    );
  }

  // Tier 1: array of singles
  if (type === 'singles') {
    const totalStake = data.reduce((s, d) => s + d.stake, 0);
    const totalProfit = data.reduce((s, d) => s + d.potentialProfit, 0);
    return (
      <div style={{
        border: `1px solid ${meta.color}44`, borderRadius: 8,
        background: meta.bg, padding: '14px 16px', marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 16 }}>{meta.icon}</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: meta.color }}>{meta.label}</span>
          <span style={{ fontSize: 10, color: '#4a5568' }}>{meta.sub}</span>
        </div>
        {data.map((d, i) => (
          <div key={i} style={{
            border: `1px solid ${meta.color}22`, borderRadius: 6,
            background: '#0a0d15', padding: '10px 12px', marginBottom: 8,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>{d.match}</div>
                <div style={{ fontSize: 10, color: '#4a5568', marginTop: 1 }}>
                  {d.league} · {timeStr(d.kickoffUTC)}
                </div>
                <div style={{ fontSize: 12, color: '#a78bfa', marginTop: 3, fontWeight: 600 }}>
                  ✓ {d.selection}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <OddsBadge odds={d.odds} />
                <ConfBadge conf={d.confidence} />
              </div>
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              marginTop: 8, paddingTop: 8, borderTop: `1px solid ${meta.color}22`,
              fontSize: 11,
            }}>
              <span style={{ color: '#8b9ab3' }}>Stake: <strong style={{ color: '#e2e8f0' }}>₦{fmt(d.stake)}</strong></span>
              <span style={{ color: '#8b9ab3' }}>Return: <strong style={{ color: meta.color }}>₦{fmt(d.potentialReturn)}</strong></span>
              <span style={{ color: meta.color, fontWeight: 700 }}>+₦{fmt(d.potentialProfit)} profit</span>
            </div>
          </div>
        ))}
        <div style={{
          display: 'flex', justifyContent: 'space-between', marginTop: 4,
          padding: '8px 0', borderTop: `1px solid ${meta.color}33`, fontSize: 11,
        }}>
          <span style={{ color: '#8b9ab3' }}>Total stake: <strong style={{ color: '#e2e8f0' }}>₦{fmt(totalStake)}</strong></span>
          <span style={{ color: meta.color, fontWeight: 800 }}>Best case: +₦{fmt(totalProfit)}</span>
        </div>
      </div>
    );
  }

  // Tier 2 / Tier 3: accumulator
  const legs = data.legs || [];
  return (
    <div style={{
      border: `1px solid ${meta.color}44`, borderRadius: 8,
      background: meta.bg, padding: '14px 16px', marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 16 }}>{meta.icon}</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: meta.color }}>{meta.label}</span>
        <span style={{ fontSize: 10, color: '#4a5568' }}>{meta.sub}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: meta.color, fontWeight: 700 }}>
          Combined: {data.combinedOdds}x
        </span>
      </div>
      <div style={{ background: '#0a0d15', borderRadius: 6, padding: '0 12px' }}>
        {legs.map((leg, i) => <LegRow key={i} leg={leg} index={i} />)}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        marginTop: 10, padding: '8px 0', borderTop: `1px solid ${meta.color}33`, fontSize: 11,
      }}>
        <span style={{ color: '#8b9ab3' }}>Stake: <strong style={{ color: '#e2e8f0' }}>₦{fmt(data.stake)}</strong></span>
        <span style={{ color: '#8b9ab3' }}>Return: <strong style={{ color: meta.color }}>₦{fmt(data.potentialReturn)}</strong></span>
        <span style={{ color: meta.color, fontWeight: 800 }}>+₦{fmt(data.potentialProfit)} profit</span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BetSlips() {
  const [slips, setSlips] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [bankroll, setBankroll] = useState(250000);
  const [inputBankroll, setInputBankroll] = useState('250000');

  const load = useCallback(async (br = bankroll) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiService.getBetSlips(br);
      setSlips(res.data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [bankroll]);

  useEffect(() => { load(); }, []);

  function handleBankrollChange(e) {
    setInputBankroll(e.target.value);
  }

  function handleBankrollApply() {
    const val = parseInt(inputBankroll.replace(/[^0-9]/g, ''), 10);
    if (val >= 1000) {
      setBankroll(val);
      load(val);
    }
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0' }}>
            V8 Bet Slips
          </div>
          <div style={{ fontSize: 11, color: '#4a5568', marginTop: 2 }}>
            AI-generated from today's calibrated fixtures
          </div>
        </div>
        <button
          onClick={() => load(bankroll)}
          disabled={loading}
          style={{
            marginLeft: 'auto', background: '#001f0e', border: '1px solid #006833',
            borderRadius: 6, padding: '6px 12px', cursor: loading ? 'not-allowed' : 'pointer',
            color: '#00b859', fontSize: 11, fontWeight: 700, opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Loading...' : '↻ Refresh'}
        </button>
      </div>

      {/* Bankroll input */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
        background: '#131826', border: '1px solid #1e2535', borderRadius: 7, padding: '10px 14px',
      }}>
        <span style={{ fontSize: 11, color: '#8b9ab3', flexShrink: 0 }}>Daily Bankroll (₦)</span>
        <input
          value={inputBankroll}
          onChange={handleBankrollChange}
          placeholder="e.g. 100000"
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            color: '#e2e8f0', fontSize: 13, fontWeight: 700,
          }}
          onKeyDown={e => e.key === 'Enter' && handleBankrollApply()}
        />
        <button
          onClick={handleBankrollApply}
          style={{
            background: '#1e2535', border: '1px solid #2d3748',
            borderRadius: 5, padding: '4px 10px', cursor: 'pointer',
            color: '#8b9ab3', fontSize: 11, fontWeight: 700,
          }}
        >
          Apply
        </button>
      </div>
      {/* Allocation hint — changes based on bankroll size */}
      {slips?.summary?.allocation && (
        <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 14, paddingLeft: 2 }}>
          Stake split: T1&nbsp;<strong style={{ color: '#00b859' }}>{slips.summary.allocation.tier1}%</strong>
          &nbsp;&middot;&nbsp;T2&nbsp;<strong style={{ color: '#fbbf24' }}>{slips.summary.allocation.tier2}%</strong>
          &nbsp;&middot;&nbsp;T3&nbsp;<strong style={{ color: '#f97316' }}>{slips.summary.allocation.tier3}%</strong>
          &nbsp;— adjusted for your bankroll to minimise losses
        </div>
      )}

      {/* Summary bar */}
      {slips?.summary && (
        <div style={{
          display: 'flex', gap: 12, marginBottom: 18,
          padding: '10px 14px', background: '#0a0d15',
          border: '1px solid #1e2535', borderRadius: 7,
        }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 2 }}>Total Stake</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#e2e8f0' }}>
              ₦{fmt(slips.summary.totalStake)}
            </div>
            <div style={{ fontSize: 9, color: '#4a5568' }}>
              {slips.summary.totalStakePercent}% of bankroll
            </div>
          </div>
          <div style={{ width: 1, background: '#1e2535' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 2 }}>Best-Case Profit</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#00b859' }}>
              +₦{fmt(slips.summary.bestCaseProfit)}
            </div>
            <div style={{ fontSize: 9, color: '#4a5568' }}>
              {slips.summary.bestCaseProfitPercent}% ROI
            </div>
          </div>
          <div style={{ width: 1, background: '#1e2535' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 2 }}>Fixtures Pool</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#e2e8f0' }}>
              {slips.pool}
            </div>
            <div style={{ fontSize: 9, color: '#4a5568' }}>qualifying games</div>
          </div>
        </div>
      )}

      {error && (
        <div style={{
          background: '#1a0000', border: '1px solid #7f1d1d',
          borderRadius: 7, padding: '12px 14px', color: '#fca5a5',
          fontSize: 12, marginBottom: 16,
        }}>
          {error} — recalibrate to get fresh fixtures.
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#4a5568', fontSize: 12 }}>
          Generating V8 bet slips...
        </div>
      ) : (
        <>
          <TierCard tier={1} data={slips?.tier1} type="singles" />
          <TierCard tier={2} data={slips?.tier2} type="accumulator" />
          <TierCard tier={3} data={slips?.tier3} type="accumulator" />

          {slips?.generatedAt && (
            <div style={{ textAlign: 'center', fontSize: 10, color: '#2d3748', marginTop: 8 }}>
              Generated {new Date(slips.generatedAt).toLocaleTimeString('en-GB')} · Recalibrate for latest fixtures
            </div>
          )}
        </>
      )}
    </div>
  );
}
