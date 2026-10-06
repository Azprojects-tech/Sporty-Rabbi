const LIVE_STATUSES = new Set(['LIVE','1H','2H','ET']);

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clean = (value) => JSON.parse(JSON.stringify(value));

function scoreParts(match = {}) {
  const score = String(match.score || '').trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (score) return { home: Number(score[1]), away: Number(score[2]) };
  const home = finite(match.homeGoals);
  const away = finite(match.awayGoals);
  return home != null && away != null ? { home, away } : null;
}

function dateUTC(value, fallbackNow) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : new Date(fallbackNow).toISOString().slice(0, 10);
}

function eligible(match = {}) {
  return Boolean(
    match.id &&
    LIVE_STATUSES.has(String(match.status || '').toUpperCase()) &&
    finite(match.matchMinutes) != null &&
    Number(match.matchMinutes) >= 12 &&
    scoreParts(match)
  );
}

export function goalFestPriority(match = {}) {
  if (!eligible(match)) return 0;
  const minute = Math.max(1, Number(match.matchMinutes));
  const score = scoreParts(match);
  const goals = score.home + score.away;
  const pace = (goals * 90) / minute;

  let priority = 0;
  if (goals >= 4) priority += 10000;
  else if (goals >= 3) priority += 8000;
  else if (goals >= 2 && minute <= 65) priority += 6000;
  else if (goals >= 1 && minute <= 30) priority += 3000;

  if (pace >= 5) priority += 2500;
  else if (pace >= 4) priority += 1800;
  else if (pace >= 3.2) priority += 1200;

  // Prefer earlier explosive states because they leave more betting time.
  priority += Math.max(0, 90 - minute);
  return priority;
}

export function selectGoalFestScanMatches(matches = [], limit = 8, cursor = 0) {
  const pool = (Array.isArray(matches) ? matches : []).filter(eligible);
  if (!pool.length || limit <= 0) return { matches: [], nextCursor: 0 };

  const capped = Math.min(Math.max(1, Number(limit) || 1), pool.length);
  const ranked = pool
    .map((match, index) => ({ match, index, priority: goalFestPriority(match) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index);

  // Deep statistics are the expensive part. Reserve only a small slice for
  // round-robin discovery; the rest is used only when the cheap score/minute
  // feed shows an explosive trajectory. This keeps the monitor useful all day
  // instead of burning its quota on quiet 0-0 / 1-0 games.
  const rotationSlots = capped === 1 ? 0 : Math.max(1, Math.floor(capped * 0.25));
  const prioritySlots = Math.max(1, capped - rotationSlots);
  const picked = [];
  const pickedIds = new Set();

  for (const row of ranked) {
    if (row.priority <= 100 || picked.length >= prioritySlots) break;
    picked.push(row.match);
    pickedIds.add(String(row.match.id));
  }

  const remaining = pool.filter((m) => !pickedIds.has(String(m.id)));
  let nextCursor = 0;
  const discoverySlots = picked.length ? rotationSlots : Math.max(1, rotationSlots);
  if (remaining.length && discoverySlots > 0) {
    const start = ((Number(cursor) || 0) % remaining.length + remaining.length) % remaining.length;
    const slots = Math.min(discoverySlots, capped - picked.length);
    for (let i = 0; i < slots && i < remaining.length; i++) {
      picked.push(remaining[(start + i) % remaining.length]);
    }
    nextCursor = (start + Math.min(slots, remaining.length)) % remaining.length;
  }

  return { matches: picked, nextCursor };
}

export function summarizeGoalFestStudies(studies = []) {
  const rows = Array.isArray(studies) ? studies : [];
  const settled = rows.filter((r) => r?.settlementStatus === 'SETTLED');
  const high = settled.filter((r) => r.highScoring === true);
  const detected = high.filter((r) => r.flagged === true);
  const missed = high.filter((r) => r.missedHighScorer === true);
  const falsePositive = settled.filter((r) => r.flagged === true && r.highScoring !== true);
  return {
    studies: rows.length,
    pending: rows.filter((r) => r?.settlementStatus === 'PENDING').length,
    settled: settled.length,
    highScorers: high.length,
    detectedHighScorers: detected.length,
    missedHighScorers: missed.length,
    flaggedNonHighScorers: falsePositive.length,
    highScorerDetectionRate: high.length ? detected.length / high.length : null,
  };
}

export function createGoalFestMonitor({
  getDb,
  readLive,
  readStats,
  evaluate,
  saveAlert,
  publish = async () => {},
  finalFromFixture = () => null,
  canCall = () => true,
  now = Date.now,
  scanLimit = 8,
  alertThreshold = 70,
  dailyDeepScanLimit = 360,
  log = console,
} = {}) {
  let inFlight = null;
  let cursor = 0;
  let deepScanDay = '';
  let deepScansToday = 0;
  let lastStatus = {
    lastCompletedAt: null,
    liveFixtures: 0,
    eligible: 0,
    deepScanned: 0,
    active: 0,
    missingEvidence: 0,
    dailyDeepScans: 0,
  };

  function refreshBudgetDay() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (day !== deepScanDay) {
      deepScanDay = day;
      deepScansToday = 0;
    }
  }

  async function persistLight(db, matches) {
    if (!db || !matches.length) return;
    let batch = db.batch();
    let writes = 0;
    const commit = async () => {
      if (!writes) return;
      await batch.commit();
      batch = db.batch();
      writes = 0;
    };

    for (const match of matches) {
      const score = scoreParts(match);
      const minute = Number(match.matchMinutes);
      const totalGoals = score.home + score.away;
      const bucket = Math.max(5, Math.min(90, Math.round(minute / 5) * 5));
      const observedAt = new Date(now()).toISOString();
      const kickoffDateUTC = dateUTC(match.kickoffUTC, now());
      const root = db.collection('goalFestStudies').doc(String(match.id));
      const snap = root.collection('snapshots').doc(String(bucket).padStart(3, '0'));
      const base = {
        fixtureId: String(match.id),
        home: match.home || '',
        away: match.away || '',
        league: match.league || '',
        leagueId: match.leagueId ?? null,
        kickoffUTC: match.kickoffUTC || null,
        kickoffDateUTC,
        detectorVersion: 'GOAL_FEST_BG_V1',
        settlementStatus: 'PENDING',
        lastObservedAt: observedAt,
        lastMinute: minute,
        lastScore: score,
        lastTotalGoals: totalGoals,
        lastGoalPace: +(totalGoals * 90 / Math.max(1, minute)).toFixed(3),
      };
      const snapshot = {
        fixtureId: String(match.id),
        bucket,
        observedAt,
        minute,
        status: match.status || null,
        score,
        totalGoals,
        goalPace: +(totalGoals * 90 / Math.max(1, minute)).toFixed(3),
        priority: goalFestPriority(match),
        deepScanned: false,
      };
      batch.set(root, clean(base), { merge: true });
      batch.set(snap, clean(snapshot), { merge: true });
      writes += 2;
      if (writes >= 380) await commit();
    }
    await commit();
  }

  async function persistDeep(db, match, stats, signal) {
    if (!db || !match?.id) return;
    const minute = Number(match.matchMinutes);
    const bucket = Math.max(5, Math.min(90, Math.round(minute / 5) * 5));
    const observedAt = new Date(now()).toISOString();
    const root = db.collection('goalFestStudies').doc(String(match.id));
    const snap = root.collection('snapshots').doc(String(bucket).padStart(3, '0'));
    const deep = {
      deepScanned: true,
      deepScannedAt: observedAt,
      statsAvailable: Boolean(stats),
      shotsOnTarget: stats?.shots || null,
      totalShots: stats?.totalShots || null,
      xg: stats?.xg || null,
      possession: stats?.possession || null,
      corners: stats?.corners || null,
      cards: stats?.cards || null,
      signal: signal || null,
    };
    await snap.set(clean(deep), { merge: true });
    await root.set(clean({
      lastDeepScanAt: observedAt,
      lastSignalStatus: signal?.status || null,
      lastSignalScore: signal?.score ?? null,
      lastSignalLevel: signal?.level || null,
      lastEvidenceAvailable: Boolean(stats),
    }), { merge: true });
  }

  async function markFlagged(db, match, signal) {
    if (!db || !match?.id) return;
    const root = db.collection('goalFestStudies').doc(String(match.id));
    const triggeredAt = new Date(now()).toISOString();
    if (typeof db.runTransaction === 'function') {
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(root);
        const current = existing.exists ? existing.data() : {};
        tx.set(root, clean({
          flagged: true,
          firstTriggeredAt: current.firstTriggeredAt || triggeredAt,
          lastTriggeredAt: triggeredAt,
          triggerCount: Number(current.triggerCount || 0) + 1,
          bestTriggeredScore: Math.max(Number(current.bestTriggeredScore || 0), Number(signal?.score || 0)),
        }), { merge: true });
      });
      return;
    }
    await root.set(clean({
      flagged: true,
      firstTriggeredAt: triggeredAt,
      lastTriggeredAt: triggeredAt,
      bestTriggeredScore: Number(signal?.score || 0),
    }), { merge: true });
  }

  async function tick(trigger = 'background') {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      refreshBudgetDay();
      if (typeof readLive !== 'function') return { skipped: true, reason: 'NO_LIVE_READER' };

      const live = await readLive();
      const pool = (Array.isArray(live) ? live : []).filter(eligible);
      const db = getDb?.() || null;
      await persistLight(db, pool);

      const selected = selectGoalFestScanMatches(pool, scanLimit, cursor);
      cursor = selected.nextCursor;
      let deepScanned = 0;
      let active = 0;
      let missingEvidence = 0;
      const evaluations = [];

      for (const match of selected.matches) {
        if (!canCall() || deepScansToday >= dailyDeepScanLimit) break;
        let stats = null;
        try {
          stats = await readStats(match);
        } catch (err) {
          log.warn?.('[GoalFest] statistics unavailable:', err.message);
        }
        deepScansToday++;
        deepScanned++;

        const observed = {
          ...match,
          ...(stats ? {
            possession: stats.possession,
            shots: stats.shots,
            totalShots: stats.totalShots,
            xg: stats.xg,
            corners: stats.corners,
            cards: stats.cards,
          } : { shots: null, xg: null }),
        };
        const signal = evaluate(observed);
        if (signal?.status === 'INSUFFICIENT_DATA') missingEvidence++;
        await persistDeep(db, match, stats, signal);
        evaluations.push({ match, observed, stats, signal });

        if (signal?.active && Number(signal.score) >= alertThreshold) {
          active++;
          await markFlagged(db, match, signal);
          await saveAlert({
            matchId: match.id,
            home: match.home,
            away: match.away,
            league: match.league,
            leagueId: match.leagueId || 0,
            matchType: match.matchType || 'League',
            country: match.leagueCountry || match.country || '',
            type: 'GOAL_FEST',
            message: `GOAL FEST ${signal.level}: ${signal.summary}`,
            confidence: signal.score,
            goalFest: signal,
            status: match.status,
            matchMinutes: match.matchMinutes || 0,
            sentAt: new Date(now()).toISOString(),
          });
        }
      }

      if (evaluations.length) await publish(evaluations);

      lastStatus = {
        lastCompletedAt: new Date(now()).toISOString(),
        trigger,
        liveFixtures: Array.isArray(live) ? live.length : 0,
        eligible: pool.length,
        deepScanned,
        active,
        missingEvidence,
        dailyDeepScans: deepScansToday,
        dailyDeepScanLimit,
      };
      log.log?.(`[GoalFest] ${trigger}: live ${lastStatus.liveFixtures}, eligible ${pool.length}, deep ${deepScanned}, active ${active}, missing ${missingEvidence}`);
      return lastStatus;
    })().catch((err) => {
      log.warn?.('[GoalFest] background scan failed:', err.message);
      lastStatus = { ...lastStatus, error: err.message, lastCompletedAt: new Date(now()).toISOString() };
      return { ...lastStatus, ok: false };
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function pendingSettlementDates() {
    const db = getDb?.();
    if (!db) return [];
    try {
      const snap = await db.collection('goalFestStudies')
        .where('settlementStatus', '==', 'PENDING')
        .limit(500)
        .get();
      const dates = new Set();
      for (const doc of snap.docs) {
        const row = doc.data();
        const kickoff = Date.parse(row.kickoffUTC || '');
        if (Number.isFinite(kickoff) && now() - kickoff < 2 * 3600000) continue;
        const day = row.kickoffDateUTC || dateUTC(row.kickoffUTC, now());
        if (day) dates.add(day);
      }
      return [...dates].sort();
    } catch (err) {
      log.warn?.('[GoalFest] pending settlement read failed:', err.message);
      return [];
    }
  }

  async function settleDate(dateStamp, fixtures = []) {
    const db = getDb?.();
    if (!db || !dateStamp) return { settled: 0, highScorers: 0, detected: 0, missed: 0 };
    const finals = new Map();
    for (const fixture of Array.isArray(fixtures) ? fixtures : []) {
      const id = fixture?.fixture?.id ?? fixture?.id;
      if (id == null) continue;
      const final = finalFromFixture(fixture);
      if (final) finals.set(String(id), final);
    }
    if (!finals.size) return { settled: 0, highScorers: 0, detected: 0, missed: 0 };

    const snap = await db.collection('goalFestStudies')
      .where('kickoffDateUTC', '==', dateStamp)
      .get();
    let batch = db.batch();
    let writes = 0;
    let settled = 0;
    let highScorers = 0;
    let detected = 0;
    let missed = 0;
    const settledAt = new Date(now()).toISOString();

    const commit = async () => {
      if (!writes) return;
      await batch.commit();
      batch = db.batch();
      writes = 0;
    };

    for (const doc of snap.docs) {
      const row = doc.data();
      if (row.settlementStatus === 'SETTLED') continue;
      const final = finals.get(String(row.fixtureId || doc.id));
      if (!final) continue;
      const home = finite(final.home);
      const away = finite(final.away);
      if (home == null || away == null) continue;
      const total = home + away;
      const highScoring = total >= 4;
      const flagged = row.flagged === true;
      const missedHighScorer = highScoring && !flagged;
      batch.set(doc.ref, clean({
        settlementStatus: 'SETTLED',
        finalScore: { home, away },
        finalTotalGoals: total,
        highScoring,
        flagged,
        detectedHighScorer: highScoring && flagged,
        missedHighScorer,
        flaggedNonHighScorer: flagged && !highScoring,
        settledAt,
      }), { merge: true });
      writes++;
      settled++;
      if (highScoring) highScorers++;
      if (highScoring && flagged) detected++;
      if (missedHighScorer) missed++;
      if (writes >= 380) await commit();
    }
    await commit();
    if (settled) log.log?.(`[GoalFest] settlement ${dateStamp}: ${settled} studies, ${highScorers} high scorers, ${detected} detected, ${missed} missed`);
    return { settled, highScorers, detected, missed };
  }

  return {
    tick,
    status: () => ({ ...lastStatus, dailyDeepScans: deepScansToday, dailyDeepScanLimit }),
    pendingSettlementDates,
    settleDate,
  };
}
