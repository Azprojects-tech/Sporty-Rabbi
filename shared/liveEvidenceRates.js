import { observedNumber } from './forecastMath.js';

// Descriptive rate only. Cumulative TOTAL shots and season TOTAL shots/90 must
// use the same unit; shots on target cannot substitute for total shots.
export function phaseBlendCountRate(seasonAverage, liveCount, elapsedMinutes, priorMinutes) {
  const base=observedNumber(seasonAverage),count=observedNumber(liveCount),minute=observedNumber(elapsedMinutes);
  if(base==null||base<0)return null;
  if(count==null||count<0||minute==null||minute<=0)return base;
  if(minute>=70)return count*90/minute;
  const prior=observedNumber(priorMinutes);
  if(prior==null||prior<=0)return base;
  const weight=minute<25?prior*1.8:prior;
  return (base*weight+count*90)/(weight+minute);
}
