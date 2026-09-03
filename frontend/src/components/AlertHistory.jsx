import React,{useState,useEffect,useCallback} from 'react';
import {apiService,on,off} from '../services/api';

const LIVE_STATUSES=new Set(['LIVE','1H','2H','HT','ET','BT','P','INT']);
const LIVE_TYPES=new Set(['GOAL_FEST','NEXT_GOAL','MOMENTUM','GOAL_PACE','LIVE_INTELLIGENCE']);
const MAX_AGE=30*60*1000;
const age=iso=>{const t=Date.parse(iso||'');return Number.isFinite(t)?Math.max(0,Date.now()-t):Infinity;};
const actionable=a=>!!a?.sentAt && age(a.sentAt)<=MAX_AGE &&
  (LIVE_TYPES.has(String(a.type||'').toUpperCase()) || LIVE_STATUSES.has(String(a.status||'').toUpperCase()));
function ukDay(v=new Date()){
  const d=v instanceof Date?v:new Date(v); if(Number.isNaN(d.getTime())) return '';
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(d); const m=Object.fromEntries(p.map(x=>[x.type,x.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
function ago(iso){const m=Math.floor(age(iso)/60000);if(m<1)return'just now';if(m<60)return`${m}m ago`;const h=Math.floor(m/60);if(h<24)return`${h}h ago`;return`${Math.floor(h/24)}d ago`;}
const confColor=c=>c>=80?'#00b859':c>=65?'#f59e0b':'#ef4444';

export default function AlertHistory(){
  const[alerts,setAlerts]=useState([]),[loading,setLoading]=useState(true),[scope,setScope]=useState('actionable');
  const load=useCallback(async()=>{try{const r=await apiService.getAlerts();setAlerts(r.data?.alerts||[]);}catch(e){console.error('Could not load alerts:',e.message);}finally{setLoading(false);}},[]);
  useEffect(()=>{
    load();
    const h=a=>setAlerts(p=>[a,...p].slice(0,100));
    on('NEW_ALERT',h);
    const timer=setInterval(load,60000);
    return()=>{clearInterval(timer);off('NEW_ALERT',h);};
  },[load]);

  const today=ukDay(), nowCount=alerts.filter(actionable).length;
  const shown=alerts.filter(a=>{
    const d=ukDay(a.sentAt), t=String(a.type||'').toUpperCase();
    if(scope==='actionable')return actionable(a);
    if(scope==='today')return d===today;
    if(scope==='goalFest')return t==='GOAL_FEST'&&d===today;
    return d!==today;
  });

  return <div style={{height:'100%',display:'flex',flexDirection:'column',overflow:'hidden'}}>
    <div style={{padding:'16px 20px 12px',borderBottom:'1px solid #1e2535',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      <div>
        <div style={{fontSize:15,fontWeight:700,color:'#e2e8f0'}}>Alerts</div>
        <div style={{fontSize:11,color:'#4a5568',marginTop:2}}>{nowCount} actionable now | older alerts remain for audit</div>
      </div>
      <button onClick={load} style={{background:'#131826',border:'1px solid #1e2535',borderRadius:6,color:'#8b9ab3',fontSize:11,padding:'5px 10px',cursor:'pointer'}}>Refresh</button>
    </div>
    <div style={{display:'flex',gap:6,padding:'10px 20px',borderBottom:'1px solid #1e2535',flexWrap:'wrap'}}>
      {[['actionable',`Actionable (${nowCount})`],['today','Today'],['goalFest','Goal Fest'],['history','History']].map(([id,label])=>
        <button key={id} onClick={()=>setScope(id)} style={{
          background:scope===id?'#001f0e':'transparent',border:'1px solid '+(scope===id?'#006833':'#1e2535'),
          borderRadius:6,padding:'5px 12px',color:scope===id?'#00b859':'#8b9ab3',fontSize:11,fontWeight:scope===id?700:400,cursor:'pointer'
        }}>{label}</button>)}
    </div>
    <div style={{flex:1,overflowY:'auto',padding:'10px 16px'}}>
      {loading?<div style={{textAlign:'center',color:'#4a5568',paddingTop:40}}>Loading alerts...</div>:
      !shown.length?<div style={{textAlign:'center',paddingTop:40,color:'#4a5568',fontSize:13}}>
        {scope==='actionable'?'No actionable live alerts right now':'No alerts in this view'}
        <div style={{color:'#2d3748',fontSize:11,marginTop:4}}>Live alerts expire from the actionable view after 30 minutes.</div>
      </div>:
      shown.map((a,i)=>{
        const act=actionable(a), gf=String(a.type||'').toUpperCase()==='GOAL_FEST';
        return <div key={a.firestoreId||`${a.matchId||'a'}-${a.sentAt||i}`} style={{
          background:'#131826',border:'1px solid #1e2535',borderLeft:'3px solid '+(gf?'#f97316':confColor(a.confidence||0)),
          borderRadius:8,padding:'12px 14px',marginBottom:8,opacity:act||scope==='actionable'?1:.72
        }}>
          <div style={{display:'flex',justifyContent:'space-between',gap:8,marginBottom:6}}>
            <div style={{fontSize:13,fontWeight:600,color:'#e2e8f0'}}>{a.home} <span style={{color:'#4a5568'}}>vs</span> {a.away}</div>
            <div style={{display:'flex',gap:6,alignItems:'center'}}>
              {gf&&<span style={{background:'#2a1200',border:'1px solid #f97316',borderRadius:5,padding:'2px 7px',fontSize:9,fontWeight:800,color:'#fb923c'}}>GOAL FEST</span>}
              <span style={{border:'1px solid '+(act?'#006833':'#2d3748'),borderRadius:5,padding:'2px 7px',fontSize:9,fontWeight:800,color:act?'#00b859':'#64748b'}}>{act?'ACTIONABLE':'EXPIRED'}</span>
              <span style={{fontSize:11,fontWeight:700,color:confColor(a.confidence||0)}}>{a.confidence||0}</span>
            </div>
          </div>
          <div style={{fontSize:10,color:'#4a5568',marginBottom:6}}>{a.league||'Match'}{a.matchMinutes?` | ${a.matchMinutes}'`:''}{a.status?` | ${a.status}`:''}</div>
          <div style={{fontSize:12,color:'#cbd5e0',background:'#0a0d15',borderRadius:6,padding:'8px 10px',lineHeight:1.5}}>
            {typeof a.message==='object'?JSON.stringify(a.message):(a.message||`${a.type||'Alert'} opportunity detected`)}
          </div>
          <div style={{fontSize:10,color:'#4a5568',marginTop:6,textAlign:'right'}}>
            {ago(a.sentAt)} | {new Date(a.sentAt).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/London'})}
          </div>
        </div>;
      })}
    </div>
  </div>;
}
