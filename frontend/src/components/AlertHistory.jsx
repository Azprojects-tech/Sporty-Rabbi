import React, { useState, useEffect, useCallback } from 'react';
import { apiService } from '../services/api';
import { on } from '../services/api';

const CONF_COLOR = (c) => {
  if (c >= 80) return '#00b859';
  if (c >= 65) return '#f59e0b';
  return '#ef4444';
};

const CONF_BG = (c) => {
  if (c >= 80) return '#001f0e';
  if (c >= 65) return '#1a1200';
  return '#1a0000';
};

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function AlertHistory() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // 'all' | 'high' | 'medium'

  const load = useCallback(async () => {
    try {
      const res = await apiService.getAlerts();
      setAlerts(res.data?.alerts || []);
    } catch (e) {
      console.error('Could not load alerts:', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Listen for real-time new alerts via WebSocket
    const unsub = on('NEW_ALERT', (alert) => {
      setAlerts((prev) => [alert, ...prev].slice(0, 100));
    });
    return () => { if (typeof unsub === 'function') unsub(); };
  }, [load]);

  const filtered = alerts.filter((a) => {
    const c = a.confidence || 0;
    if (filter === 'high') return c >= 80;
    if (filter === 'medium') return c >= 65 && c < 80;
    return true;
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px 12px',
        borderBottom: '1px solid #1e2535',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>
            Alert History
          </div>
          <div style={{ fontSize: 11, color: '#4a5568', marginTop: 2 }}>
            {alerts.length} alerts stored • persisted via Firestore
          </div>
        </div>
        <button
          onClick={load}
          style={{
            background: '#131826', border: '1px solid #1e2535', borderRadius: 6,
            color: '#8b9ab3', fontSize: 11, padding: '5px 10px', cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>

      {/* Filter tabs */}
      <div style={{
        display: 'flex', gap: 6, padding: '10px 20px',
        borderBottom: '1px solid #1e2535', flexShrink: 0,
      }}>
        {[
          { id: 'all', label: 'All' },
          { id: 'high', label: '80%+ Confidence' },
          { id: 'medium', label: '65–79%' },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              background: filter === f.id ? '#001f0e' : 'transparent',
              border: '1px solid ' + (filter === f.id ? '#006833' : '#1e2535'),
              borderRadius: 6, padding: '5px 12px',
              color: filter === f.id ? '#00b859' : '#8b9ab3',
              fontSize: 11, fontWeight: filter === f.id ? 700 : 400,
              cursor: 'pointer',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: '#4a5568', paddingTop: 40, fontSize: 13 }}>
            Loading alerts...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 40 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🔕</div>
            <div style={{ color: '#4a5568', fontSize: 13 }}>No alerts yet</div>
            <div style={{ color: '#2d3748', fontSize: 11, marginTop: 4 }}>
              Alerts fire when a live match hits the confidence threshold
            </div>
          </div>
        ) : (
          filtered.map((alert, i) => (
            <div
              key={alert.firestoreId || i}
              style={{
                background: '#131826',
                border: '1px solid #1e2535',
                borderLeft: `3px solid ${CONF_COLOR(alert.confidence || 0)}`,
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 8,
              }}
            >
              {/* Match + confidence */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>
                  {alert.home} <span style={{ color: '#4a5568' }}>vs</span> {alert.away}
                </div>
                <div style={{
                  background: CONF_BG(alert.confidence || 0),
                  border: `1px solid ${CONF_COLOR(alert.confidence || 0)}44`,
                  borderRadius: 5, padding: '2px 8px',
                  fontSize: 11, fontWeight: 700,
                  color: CONF_COLOR(alert.confidence || 0),
                }}>
                  {alert.confidence || 0}%
                </div>
              </div>

              {/* League */}
              {alert.league && (
                <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 6 }}>
                  {alert.league}
                </div>
              )}

              {/* Alert message */}
              <div style={{
                fontSize: 12, color: '#cbd5e0',
                background: '#0a0d15', borderRadius: 6,
                padding: '8px 10px', lineHeight: 1.5,
              }}>
                {typeof alert.message === 'object'
                  ? JSON.stringify(alert.message)
                  : alert.message || `${alert.type || 'Alert'} opportunity detected`}
              </div>

              {/* Timestamp */}
              <div style={{ fontSize: 10, color: '#4a5568', marginTop: 6, textAlign: 'right' }}>
                {timeAgo(alert.sentAt)} • {new Date(alert.sentAt).toLocaleString('en-GB', {
                  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
