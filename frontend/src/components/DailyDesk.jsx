import React,{useEffect,useState} from 'react';
import {apiService} from '../services/api';
const pct=n=>Number.isFinite(n)?`${n.toFixed(1)}%`:'Unavailable';
const panel={padding:18,border:'1px solid #253047',borderRadius:12,background:'#101725',marginBottom:14};
export default function DailyDesk({onOpenMatch,onBrowse}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[played,setPlayed]=useState([]);
 const [playing,setPlaying]=useState(null),[stake,setStake]=useState(''),[odds,setOdds]=useState(''),[paper,setPaper]=useState(false),[playMessage,setPlayMessage]=useState(''),[saving,setSaving]=useState(false);
 const recordPlay=async o=>{setSaving(true);setPlayMessage('');try{const requestId=globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2);await apiService.client.post('/opportunities/played',{opportunityId:o.id,clientRequestId:requestId,stake:Number(stake),odds:Number(odds),paper,bookmaker:'SportyBet'});setPlayMessage('Recorded. Your actual odds and stake have been saved.');setPlaying(null);setStake('');setOdds('');load();}catch(e){setPlayMessage(e.response?.data?.error||'Could not save. Please retry.');}finally{setSaving(false);}};
 const load=async()=>{try{const [desk,bets]=await Promise.all([apiService.client.get('/daily-desk'),apiService.client.get('/opportunities/played').catch(()=>({data:{bets:[]}}))]);setData(desk.data);setPlayed(bets.data.bets||[]);setError('');}catch{setError('Could not refresh the shortlist.');}};
 useEffect(()=>{load();const id=setInterval(load,60000);return()=>clearInterval(id);},[]);
 return <main style={{flex:1,minWidth:0,overflowY:'auto',padding:18,color:'#e2e8f0'}}>
  <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:12,marginBottom:18}}><h2 style={{margin:0}}>Daily picks</h2>
   <button onClick={load}>Refresh</button><button onClick={onBrowse}>All matches</button></div>
  <p>{data?.enabled?'Telegram follows this shortlist, even when you close the portal.':'Daily monitoring is not enabled.'}</p>
  {error&&<p role="alert">{error}</p>}
  {!data?.desk&&<p>The shortlist will appear after daily preparation and the next monitoring check.</p>}
  {data?.desk&&<p style={{color:'#94a3b8'}}>Prepared {new Date(data.desk.generatedAt).toLocaleString('en-GB',{timeZone:'Europe/London'})} UK · Pre-match forecasts</p>}
  {!!data?.recentUpdates?.length&&<section style={panel}><h3>Live updates</h3>{data.recentUpdates.map(u=><details key={u.key}><summary>{new Date(u.at).toLocaleTimeString('en-GB',{timeZone:'Europe/London'})} UK · {u.type.replaceAll('_',' ')} · Telegram {u.delivery}</summary><p style={{whiteSpace:'pre-wrap'}}>{u.message}</p></details>)}</section>}
  {(data?.desk?.cards||[]).map(c=>{
   const started=Date.parse(c.kickoffUTC)<=Date.now();
   const quoteCurrent=!started&&Date.parse(c.quoteExpiresAt)>Date.now();
   return <article key={c.id} style={panel}>
    <button onClick={()=>onOpenMatch(c.id)} style={{border:0,background:'none',color:'#e2e8f0',fontWeight:700,fontSize:17,padding:0,textAlign:'left'}}>{c.home} v {c.away}</button>
    <p style={{color:'#94a3b8'}}>{c.league} · {new Date(c.kickoffUTC).toLocaleTimeString('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'})} UK{started?' · Kickoff passed':''}</p>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))',gap:12}}>
     {['home_win','draw','away_win','over15','over25','btts'].map(k=>{const m=c.markets.find(m=>m.marketKey===k);return <div key={k}><small style={{color:'#94a3b8'}}>{({home_win:'Home win',draw:'Draw',away_win:'Away win',over15:'Over 1.5',over25:'Over 2.5',btts:'Both score'})[k]}</small><div style={{fontSize:20,fontWeight:700}}>{pct(m?.probability)}</div></div>;})}
    </div>
    <p style={{color:'#4ade80'}}>{c.best.selection} · {pct(c.best.probability)} · Minimum odds {c.best.minimumOdds.toFixed(2)}</p>
    <p>{quoteCurrent&&c.best.odds?`${c.bookmaker?.name} ${c.best.odds.toFixed(2)} · ${c.best.decision==='BET'?'Qualifies':'Watch'}`:started?'Following the match':'Current price unavailable'}</p>
    {c.quoteAt&&<small>Reference price checked {new Date(c.quoteAt).toLocaleTimeString('en-GB',{timeZone:'Europe/London'})} UK</small>}
    <p>{c.corners?Object.entries(c.corners.lines).map(([k,p])=>`Corners over ${k.replace('corners_over','').replace(/(\d)$/,'.$1')}: ${pct(p)}`).join(' · '):'Corners unavailable'}</p>
    <details><summary>Why this game?</summary><p>Evidence score {c.evidence}/100. {c.best.basis==='VALIDATED_CORRECTION'?'The selected chance includes a historical correction that passed later-match testing.':'The selected chance comes from the current goal-rate model.'}</p><p>{c.contextSummary}</p><p>Open the match for team history and the analyst note.</p></details>
   </article>;
  })}
  {!!data?.desk?.opportunities?.length&&<section style={panel}><h3>Opportunity discovery</h3><p style={{color:'#94a3b8'}}>Research-led combinations, including speculative options. You decide whether to play.</p>{data.desk.opportunities.map(o=><details key={o.id} style={{marginBottom:12,padding:10,border:'1px solid #334155',borderRadius:8}}><summary style={{cursor:'pointer'}}><strong>{o.title} · {o.legs.length} matches · {pct(o.combinedProbability)} combined</strong></summary><p>Estimated fair odds {o.fairOdds} · {o.combinedReferenceOdds?'Reference combined odds '+o.combinedReferenceOdds:'Combined bookmaker price unavailable'}</p><ul>{o.legs.map(l=><li key={l.fixtureId}>{l.match} — {l.selection} ({pct(l.probability)})<details><summary>Research evidence</summary><small>{l.researchEvidence}</small></details></li>)}</ul><small>{o.note}</small><p>Open individual matches to review the evidence.</p><button disabled={o.legs.some(l=>Date.parse(l.kickoffUTC)<=Date.now())} onClick={()=>{setPlaying(playing===o.id?null:o.id);setPlayMessage('');}}>I played this</button>{playing===o.id&&<div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:8}}><input aria-label="Actual stake" type="number" min="1" step="0.01" placeholder="Actual stake" value={stake} onChange={e=>setStake(e.target.value)}/><input aria-label="Actual combined SportyBet odds" type="number" min="1.01" step="0.01" placeholder="Actual combined odds" value={odds} onChange={e=>setOdds(e.target.value)}/><label><input type="checkbox" checked={paper} onChange={e=>setPaper(e.target.checked)}/> Practice</label><button disabled={saving||!(Number(stake)>0)||!(Number(odds)>1)} onClick={()=>recordPlay(o)}>{saving?'Saving...':'Confirm played'}</button></div>}{playMessage&&<p role="status">{playMessage}</p>}</details>)}</section>}
  {!!played.length&&<section style={panel}><h3>My played opportunities</h3>{played.slice(0,12).map(b=><p key={b.id}>{b.matchName} · {b.result} · Stake {b.stake} · Odds {b.odds}{Number.isFinite(b.profit)?' · Net '+b.profit.toFixed(2):''}{b.paper?' · Practice':''}</p>)}</section>}
  {(data?.desk?.combinations||[]).map(c=><section key={c.target} style={panel}><strong>Target total odds {c.target}.0</strong>
   {c.available?<><p>{c.legs.map(l=>`${l.match}: ${l.selection}`).join(' + ')}</p><p>Recorded odds {c.odds} · Combined probability floor {c.probabilityFloor}% · {c.bookmaker?.name}</p><small>Prices recorded with the shortlist; check current availability.</small></>:<p>No combination meets the probability and price requirements.</p>}</section>)}
 </main>;
}
