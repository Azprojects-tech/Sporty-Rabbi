import { dynamicTeamKey } from '../../../shared/dynamicStrengthModel.js';

export const API_HISTORY_COLLECTION = 'v11LeagueHistory';
export const API_HISTORY_SOURCE = 'API_FOOTBALL';
export const API_HISTORY_SEASON_OFFSETS = Object.freeze([0,-1,-2]);
export const API_HISTORY_MAX_AGE_MS = 30 * 24 * 3600000;

const DONE = new Set(['FT']);
const finite=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};

export function parseApiFootballHistoryFixtures(fixtures=[]){
  const rows=[];
  for(const f of fixtures||[]){
    const status=String(f?.fixture?.status?.short||'').toUpperCase();
    if(!DONE.has(status))continue;
    const leagueId=finite(f?.league?.id),season=finite(f?.league?.season);
    const home=String(f?.teams?.home?.name||'').trim(),away=String(f?.teams?.away?.name||'').trim();
    const hg=finite(f?.goals?.home),ag=finite(f?.goals?.away),kickoff=Date.parse(f?.fixture?.date||'');
    const fixtureId=String(f?.fixture?.id??'');
    if(!(leagueId>0)||!Number.isInteger(season)||!fixtureId||!home||!away||home===away
      ||!Number.isInteger(hg)||!Number.isInteger(ag)||!Number.isFinite(kickoff))continue;
    rows.push({
      fixtureId:`api:${fixtureId}`,
      providerFixtureId:fixtureId,
      leagueId,
      league:String(f?.league?.name||''),
      leagueCountry:String(f?.league?.country||''),
      season,
      kickoff,
      kickoffUTC:new Date(kickoff).toISOString(),
      home,away,
      homeKey:dynamicTeamKey(home),
      awayKey:dynamicTeamKey(away),
      homeGoals:hg,awayGoals:ag,
      source:API_HISTORY_SOURCE,
    });
  }
  return rows.sort((a,b)=>a.kickoff-b.kickoff||a.fixtureId.localeCompare(b.fixtureId));
}

function docId(leagueId,season){return `${Number(leagueId)}_${Number(season)}`;}

export function createApiFootballHistoryService({
  getDb,
  request,
  canCall=()=>true,
  onResponse=()=>{},
  now=()=>Date.now(),
  log=console,
}={}){
  const memory=new Map();
  const inflight=new Map();

  async function readStoredDoc(leagueId,season){
    const id=docId(leagueId,season);
    if(memory.has(id))return memory.get(id);
    const db=getDb?.();
    if(!db)return null;
    try{
      const snap=await db.collection(API_HISTORY_COLLECTION).doc(id).get();
      if(!snap.exists)return null;
      const data=snap.data()||{};
      const rows=Array.isArray(data.rows)?data.rows:[];
      const out={...data,rows};
      memory.set(id,out);
      return out;
    }catch(err){
      log.warn?.('[V11 API history] read failed:',err.message);
      return null;
    }
  }

  async function saveStoredDoc(leagueId,season,rows){
    const id=docId(leagueId,season),updatedAt=new Date(now()).toISOString();
    const league=rows[0]?.league||'',leagueCountry=rows[0]?.leagueCountry||'';
    const data={leagueId:Number(leagueId),season:Number(season),league,leagueCountry,source:API_HISTORY_SOURCE,updatedAt,rows};
    memory.set(id,data);
    const db=getDb?.();
    if(db){
      try{await db.collection(API_HISTORY_COLLECTION).doc(id).set(data);}
      catch(err){log.warn?.('[V11 API history] save failed:',err.message);}
    }
    return data;
  }

  async function fetchSeason(leagueId,season,{force=false}={}){
    const id=docId(leagueId,season);
    if(inflight.has(id))return inflight.get(id);
    const task=(async()=>{
      const stored=await readStoredDoc(leagueId,season);
      const age=stored?.updatedAt?now()-Date.parse(stored.updatedAt):Infinity;
      if(!force&&stored?.rows?.length&&age<API_HISTORY_MAX_AGE_MS){
        return {ok:true,skipped:true,leagueId:Number(leagueId),season:Number(season),rows:stored.rows};
      }
      if(typeof request!=='function'||!canCall())return {ok:false,reason:'API_UNAVAILABLE',leagueId:Number(leagueId),season:Number(season),rows:stored?.rows||[]};
      try{
        const response=await request('/fixtures',{league:Number(leagueId),season:Number(season)},()=>canCall());
        onResponse(response?.headers||{});
        const rows=parseApiFootballHistoryFixtures(response?.data?.response||[]);
        if(rows.length)await saveStoredDoc(leagueId,season,rows);
        log.log?.(`[V11 API history] league ${leagueId} season ${season}: ${rows.length} completed fixtures`);
        return {ok:rows.length>0,leagueId:Number(leagueId),season:Number(season),rows:rows.length?rows:(stored?.rows||[]),reason:rows.length?'OK':'NO_COMPLETED_FIXTURES'};
      }catch(err){
        if(err?.response?.headers)onResponse(err.response.headers);
        log.warn?.(`[V11 API history] league ${leagueId} season ${season} failed: ${err.message}`);
        return {ok:false,reason:err.message,leagueId:Number(leagueId),season:Number(season),rows:stored?.rows||[]};
      }
    })().finally(()=>inflight.delete(id));
    inflight.set(id,task);
    return task;
  }

  async function loadStoredRows(){
    const db=getDb?.();
    if(!db)return [...memory.values()].flatMap(x=>x.rows||[]);
    try{
      const snap=await db.collection(API_HISTORY_COLLECTION).limit(300).get();
      const rows=[];
      for(const d of snap.docs){
        const data=d.data()||{};
        memory.set(d.id,{...data,rows:Array.isArray(data.rows)?data.rows:[]});
        rows.push(...(Array.isArray(data.rows)?data.rows:[]));
      }
      return rows;
    }catch(err){
      log.warn?.('[V11 API history] cache load failed:',err.message);
      return [...memory.values()].flatMap(x=>x.rows||[]);
    }
  }

  async function backfillMatches(matches=[],{maxCalls=12,skipLeagueIds=new Set()}={}){
    const targets=[];
    const seen=new Set();
    for(const m of matches||[]){
      const leagueId=finite(m?.leagueId),season=finite(m?.season);
      if(!(leagueId>0)||!Number.isInteger(season)||skipLeagueIds.has(Number(leagueId)))continue;
      for(const offset of API_HISTORY_SEASON_OFFSETS){
        const s=season+offset,key=docId(leagueId,s);
        if(seen.has(key))continue;
        seen.add(key);targets.push({leagueId:Number(leagueId),season:s});
      }
    }
    let calls=0,loaded=0,skipped=0,failed=0;
    for(const t of targets){
      if(calls>=Math.max(0,Number(maxCalls)||0)||!canCall())break;
      const before=await readStoredDoc(t.leagueId,t.season);
      const age=before?.updatedAt?now()-Date.parse(before.updatedAt):Infinity;
      if(before?.rows?.length&&age<API_HISTORY_MAX_AGE_MS){skipped++;continue;}
      calls++;
      const r=await fetchSeason(t.leagueId,t.season);
      if(r.ok)loaded+=r.rows?.length||0;else failed++;
    }
    return {targets:targets.length,calls,loaded,skipped,failed};
  }

  return {fetchSeason,loadStoredRows,backfillMatches};
}
