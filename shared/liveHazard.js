const number = value => {
  if (value == null || value === '' || !['number','string'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const clamp = (value,min,max) => Math.max(min,Math.min(max,value));

const pair = (value) => ({
  home:number(value?.home),
  away:number(value?.away),
});

function posteriorPer90(priorPer90, observedCount, elapsedMinutes, priorMinutes) {
  const prior=number(priorPer90), observed=number(observedCount), minute=number(elapsedMinutes);
  if(prior==null || prior<=0 || observed==null || minute==null || minute<=0) return null;
  return (prior*priorMinutes + observed*90)/(priorMinutes+minute);
}

/**
 * Literature-informed live evidence layer.
 *
 * The score/minute/red-card model remains the backbone. This layer only adjusts
 * the already-computed remaining goal rates. It deliberately uses strong
 * shrinkage because the coefficients have not yet been fitted on SportyRabbi's
 * own live sample.
 *
 * Priority:
 *   1) verified live xG for both teams
 *   2) total-shot pace, with SOT used only to tilt the home/away split
 *   3) no live-evidence adjustment
 *
 * Corners are intentionally excluded from goal probability in V1.
 */
export function applyLiveHazardEvidence({
  match={},
  minute,
  baseHomeRate,
  baseAwayRate,
  homeRemaining,
  awayRemaining,
}={}) {
  const baseTotal=(number(homeRemaining)??0)+(number(awayRemaining)??0);
  const output={
    version:'LIVE_HAZARD_V1',
    source:'NONE',
    locallyCalibrated:false,
    homeMultiplier:1,
    awayMultiplier:1,
    baselineRemainingLambda:{home:homeRemaining,away:awayRemaining},
    adjustedRemainingLambda:{home:homeRemaining,away:awayRemaining},
    evidence:{xg:pair(match.xg),shotsOnTarget:pair(match.shots),totalShots:pair(match.totalShots),corners:pair(match.corners)},
    note:'No verified live evidence adjustment applied.',
  };
  const m=number(minute);
  if(m==null || m<=0 || m>=90 || !(baseTotal>0)) return output;

  const xg=output.evidence.xg;
  if(xg.home!=null && xg.away!=null) {
    // Two full-match-equivalents of prior weight keeps early xG from overwhelming
    // the pre-match model while still allowing sustained chance quality to move it.
    const priorMinutes=180;
    const hPosterior=posteriorPer90(baseHomeRate,xg.home,m,priorMinutes);
    const aPosterior=posteriorPer90(baseAwayRate,xg.away,m,priorMinutes);
    if(hPosterior!=null && aPosterior!=null) {
      const hMult=clamp(hPosterior/baseHomeRate,0.75,1.30);
      const aMult=clamp(aPosterior/baseAwayRate,0.75,1.30);
      const home=homeRemaining*hMult, away=awayRemaining*aMult;
      return {...output,source:'XG',homeMultiplier:hMult,awayMultiplier:aMult,
        adjustedRemainingLambda:{home,away},
        note:'Live xG adjusted the remaining goal rates with strong prior shrinkage.'};
    }
  }

  const totalShots=output.evidence.totalShots;
  const sot=output.evidence.shotsOnTarget;
  const homeShotPrior=number(match.homeShotsPerGame), awayShotPrior=number(match.awayShotsPerGame);
  if(homeShotPrior!=null && awayShotPrior!=null && homeShotPrior+awayShotPrior>0
    && totalShots.home!=null && totalShots.away!=null) {
    // Shot volume is a weaker proxy than xG, so use a longer prior and square-root
    // elasticity. This prevents a frantic first ten minutes from doubling goal rates.
    const priorMinutes=270;
    const priorTotal=homeShotPrior+awayShotPrior;
    const observedTotal=totalShots.home+totalShots.away;
    const posteriorTotal=posteriorPer90(priorTotal,observedTotal,m,priorMinutes);
    if(posteriorTotal!=null) {
      const totalMultiplier=clamp(Math.sqrt(posteriorTotal/priorTotal),0.85,1.18);
      const adjustedTotal=baseTotal*totalMultiplier;
      let homeShare=homeRemaining/baseTotal;
      // SOT is used to tilt which side owns the pressure, not to create extra
      // total-goal intensity by itself. A one-match-equivalent prior avoids noise.
      if(sot.home!=null && sot.away!=null && sot.home+sot.away>0) {
        const priorSot=8;
        const observedShare=sot.home/(sot.home+sot.away);
        homeShare=(homeShare*priorSot + observedShare*(sot.home+sot.away))/(priorSot+sot.home+sot.away);
        homeShare=clamp(homeShare,0.12,0.88);
      }
      const home=adjustedTotal*homeShare, away=adjustedTotal-home;
      return {...output,source:sot.home!=null&&sot.away!=null?'SHOTS_SOT':'SHOTS',
        homeMultiplier:homeRemaining>0?home/homeRemaining:1,
        awayMultiplier:awayRemaining>0?away/awayRemaining:1,
        adjustedRemainingLambda:{home,away},
        note:sot.home!=null&&sot.away!=null
          ? 'Live shot pace adjusted total intensity; shots on target tilted the team split.'
          : 'Live shot pace adjusted total intensity; SOT was unavailable.'};
    }
  }

  return output;
}
