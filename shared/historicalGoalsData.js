import { FD_LEAGUES, fdSeasonCode, matchTeamName } from './cornersModel.js';
import { dynamicTeamKey } from './dynamicStrengthModel.js';

export const FOOTBALL_DATA_STRENGTH_SOURCE = 'football-data.co.uk';
export const FOOTBALL_DATA_STRENGTH_BASE = 'https://www.football-data.co.uk/mmz4281';
export const FOOTBALL_DATA_STRENGTH_SEASON_OFFSETS = Object.freeze([0, -1, -2]);

function parseDate(value=''){
  const m=String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if(!m)return null;
  const year=m[3].length===2?2000+Number(m[3]):Number(m[3]);
  return Date.UTC(year,Number(m[2])-1,Number(m[1]),12);
}

/**
 * Parse only the fields V11.1 needs. Unlike the corners parser this deliberately
 * does not require HC/AC, so a valid goals result remains usable even if a file
 * has no corner columns.
 */
export function parseFdGoalsCsv(text=''){
  const lines=String(text).replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.trim());
  if(lines.length<2)return[];
  const head=lines[0].split(',').map(x=>x.trim());
  const ix=Object.fromEntries(['Date','HomeTeam','AwayTeam','FTHG','FTAG'].map(k=>[k,head.indexOf(k)]));
  if(Object.values(ix).some(i=>i<0))return[];
  const rows=[];
  for(const line of lines.slice(1)){
    const c=line.split(',');
    const date=parseDate(c[ix.Date]),hg=Number(c[ix.FTHG]),ag=Number(c[ix.FTAG]);
    const home=String(c[ix.HomeTeam]||'').trim(),away=String(c[ix.AwayTeam]||'').trim();
    if(date==null||!home||!away||!Number.isInteger(hg)||!Number.isInteger(ag))continue;
    rows.push({date,home,away,hg,ag});
  }
  return rows;
}

export function footballDataRowsForStrength(code, rows=[]){
  const league=FD_LEAGUES[code];
  if(!league)return[];
  return rows.map((r,i)=>({
    fixtureId:`fd:${code}:${r.date}:${i}`,
    leagueId:league.id,
    league:league.name,
    leagueCountry:league.country,
    kickoff:r.date,
    kickoffUTC:new Date(r.date).toISOString(),
    home:r.home,
    away:r.away,
    homeKey:dynamicTeamKey(r.home),
    awayKey:dynamicTeamKey(r.away),
    homeGoals:r.hg,
    awayGoals:r.ag,
    source:FOOTBALL_DATA_STRENGTH_SOURCE,
  })).filter(r=>r.homeKey&&r.awayKey&&r.homeKey!==r.awayKey);
}

export function footballDataUrl(code,date=new Date(),offset=0){
  return `${FOOTBALL_DATA_STRENGTH_BASE}/${fdSeasonCode(date,offset)}/${code}.csv`;
}

export function teamsByLeagueFromRows(rows=[]){
  const map={};
  for(const r of rows){
    const k=String(r.leagueId);
    const set=map[k]||(map[k]=new Set());
    if(r.home)set.add(r.home);
    if(r.away)set.add(r.away);
  }
  return Object.fromEntries(Object.entries(map).map(([k,v])=>[k,[...v]]));
}

/**
 * Translate an API-Football team name to the historical-source spelling used
 * by the fitted model. This is identity plumbing only; it changes no model
 * threshold, coefficient or probability calculation.
 */
export function mapMatchToHistoricalNames(match={},teamsByLeague={}){
  const candidates=teamsByLeague[String(match.leagueId)]||[];
  if(!candidates.length)return match;
  const home=matchTeamName(match.home,candidates)||match.home;
  const away=matchTeamName(match.away,candidates)||match.away;
  return {...match,home,away};
}
