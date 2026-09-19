import React from 'react';

export function EvidenceContents({ item }) {
  return <div style={{ padding: '10px 2px', fontSize: 12, lineHeight: 1.6, color: '#bac6d8', overflowWrap: 'anywhere' }}>
    <dl style={{ margin: 0 }}>
      {(item.rows || []).map((r,i) => <div key={i} style={{ padding: '5px 0', borderBottom: '1px solid #1e2535' }}>
        <dt style={{ color: '#8b9ab3', fontSize: 11 }}>{r.label}</dt>
        <dd style={{ margin: 0 }}>{r.value == null ? 'Unavailable' : typeof r.value === 'boolean' ? r.value ? 'Yes' : 'No' : String(r.value)}</dd>
      </div>)}
    </dl>
    <p><strong>How it is calculated:</strong> {item.method}</p>
    <p><strong>Use in Rabbi:</strong> {item.modelUse}</p>
    <div style={{ color: '#8b9ab3', fontSize: 11 }}>Source: {item.source}</div>
  </div>;
}

export function EvidenceCard({ item }) {
  return <details style={{ background: '#0f1117', border: '1px solid #283147', borderRadius: 7, padding: '10px 12px', marginTop: 8 }}>
    <summary style={{ cursor: 'pointer', color: '#d5ddeb', fontSize: 12, minHeight: 30, overflowWrap: 'anywhere' }}>
      {item.title}<span style={{ display: 'block', color: '#8b9ab3', marginTop: 3 }}>{item.summary}</span>
    </summary>
    <EvidenceContents item={item} />
  </details>;
}
