// Statistical research profiles from observed completed fixtures only.
// Does not fetch data, make selections or alter the existing prediction engine.
const fraction=(wins,total)=>total?Number((wins/total).toFixed(4)):null;
export function researchTeam(fixtures, teamId, {minimumSample=8}={}){
  const rows=(fixtures||[]).filter(f=>f?.status==='FT' && [f.homeTeamId,f.awayTeamId].some(id=>String(id)===String(teamId)) &&
    Number.isInteger(f.homeGoals) && Number.isInteger(f.awayGoals) && f.homeGoals>=0 && f.awayGoals>=0);
  const n=rows.length;
  const wins=rows.filter(f=>String(f.homeTeamId)===String(teamId)?f.homeGoals>f.awayGoals:f.awayGoals>f.homeGoals).length;
  const over25=rows.filter(f=>f.homeGoals+f.awayGoals>=3).length;
  const btts=rows.filter(f=>f.homeGoals>0&&f.awayGoals>0).length;
  const cornerRows=rows.filter(f=>Number.isInteger(f.homeCorners)&&Number.isInteger(f.awayCorners)&&f.homeCorners>=0&&f.awayCorners>=0);
  return {teamId,sampleSize:n,sufficientSample:n>=minimumSample,
    winRate:fraction(wins,n),over25Rate:fraction(over25,n),bttsRate:fraction(btts,n),
    cornersSample:cornerRows.length,over85CornersRate:fraction(cornerRows.filter(f=>f.homeCorners+f.awayCorners>=9).length,cornerRows.length),
    note:n<minimumSample?'Insufficient completed fixtures for a stable research profile':'Descriptive historical patterns only; not predictive probabilities'};
}
export function researchLeague(fixtures,leagueId,{minimumSample=20}={}){
  const rows=(fixtures||[]).filter(f=>f?.status==='FT'&&String(f.leagueId)===String(leagueId)&&
    Number.isInteger(f.homeGoals)&&Number.isInteger(f.awayGoals)&&f.homeGoals>=0&&f.awayGoals>=0);
  return {leagueId,sampleSize:rows.length,sufficientSample:rows.length>=minimumSample,
    over25Rate:fraction(rows.filter(f=>f.homeGoals+f.awayGoals>=3).length,rows.length),
    bttsRate:fraction(rows.filter(f=>f.homeGoals>0&&f.awayGoals>0).length,rows.length)};
}
