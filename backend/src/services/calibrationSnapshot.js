/**
 * Pure helper: build the possession/shots/xg snapshot for a calibration fixture.
 * Lives outside server.js so tests can import it without starting the server
 * (importing server.js opens the HTTP port, cron jobs and timers, which made
 * `npm test` hang forever).
 */
export function buildCalibrationSnapshotStats(f) {
  return {
    possession: { home: null, away: null },
    shots:      { home: null, away: null },
    xg:         { home: f?.home?.xgAvg ?? null, away: f?.away?.xgAvg ?? null },
  };
}
