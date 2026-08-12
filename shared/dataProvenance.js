/**
 * Lightweight data provenance tracker.
 * Every model-critical value must carry one of these statuses.
 * ESTIMATED, STALE, and CONTEXT_MISMATCH must never reach the model as evidence.
 */

export const PROVENANCE_STATUS = {
  API_VERIFIED:          'API_VERIFIED',
  DERIVED_FROM_VERIFIED: 'DERIVED_FROM_VERIFIED',
  SEARCH_GROUNDED:       'SEARCH_GROUNDED',
  USER_ENTERED:          'USER_ENTERED',
  MISSING:               'MISSING',
  INVALID:               'INVALID',
  STALE:                 'STALE',
  CONTEXT_MISMATCH:      'CONTEXT_MISMATCH',
  ESTIMATED:             'ESTIMATED',
};

// Statuses that must not be accepted as model evidence
export const BLOCKED_STATUSES = new Set([
  PROVENANCE_STATUS.ESTIMATED,
  PROVENANCE_STATUS.STALE,
  PROVENANCE_STATUS.CONTEXT_MISMATCH,
  PROVENANCE_STATUS.INVALID,
]);

/**
 * Wrap a value with its provenance metadata.
 * value=null means the data is genuinely absent — not a default substitute.
 */
export function sourceValue({
  value = null,
  provider = null,
  sourceType = null,
  leagueId = null,
  season = null,
  group = null,
  fixtureId = null,
  teamId = null,
  retrievedAt = new Date().toISOString(),
  verificationStatus = PROVENANCE_STATUS.MISSING,
  missingReason = null,
} = {}) {
  return {
    value,
    provider,
    sourceType,
    leagueId,
    season,
    group,
    fixtureId,
    teamId,
    retrievedAt,
    verificationStatus,
    missingReason,
  };
}

/** Returns true only if the value carries an acceptable verification status. */
export function isAcceptable(sourcedValue) {
  if (sourcedValue == null) return false;
  return !BLOCKED_STATUSES.has(sourcedValue.verificationStatus);
}
