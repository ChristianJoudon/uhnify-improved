import moment from 'moment-timezone';

export const REVIEW_TIME_ZONE = 'Pacific/Honolulu';
export const REVIEW_HORIZON_MONTHS = 2;

export const candidateDocumentKey = document => (
  String(document?.sourceId || document?.id || document?._id || 'unknown')
);

export const candidateKind = candidate => {
  if (candidate?.entityHint === 'group' || candidate?.entityHint === 'event') return candidate.entityHint;
  if (String(candidate?.sourceItemKey || '').startsWith('group:')) return 'group';
  if (String(candidate?.sourceItemKey || '').startsWith('event:')) return 'event';
  return 'candidate';
};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export const effectiveReviewFields = candidate => {
  const fields = { ...(candidate?.normalizedFields || {}) };
  const overrides = candidate?.editorialOverrides || {};
  if (typeof overrides.title === 'string' && overrides.title.trim()) {
    fields.title = overrides.title;
  }
  if (typeof overrides.location === 'string' && overrides.location.trim()) {
    fields.location = overrides.location;
    fields.locationLabels = [overrides.location];
  }
  if (overrides.schedule && typeof overrides.schedule === 'object') {
    delete fields.localStart;
    delete fields.localEnd;
    delete fields.recurrenceLabel;
    delete fields.recurrenceLabels;
    if (overrides.schedule?.kind === 'ONE_TIME') {
      fields.localStart = overrides.schedule.localStart;
      if (overrides.schedule.localEnd) fields.localEnd = overrides.schedule.localEnd;
    } else if (overrides.schedule?.kind === 'RECURRENCE') {
      fields.recurrenceLabel = overrides.schedule.recurrenceLabel;
      fields.recurrenceLabels = [overrides.schedule.recurrenceLabel];
    }
  }
  return fields;
};

export const candidateTitle = candidate => {
  const fields = effectiveReviewFields(candidate);
  if (hasOwn(candidate?.editorialOverrides, 'title')) {
    return fields.title || 'Untitled intake candidate';
  }
  return fields.title
    || candidate?.summary?.title
    || (typeof candidate?.summary === 'string' ? candidate.summary : null)
    || 'Untitled intake candidate';
};

export const candidateLocation = candidate => {
  const fields = effectiveReviewFields(candidate);
  if (hasOwn(candidate?.editorialOverrides, 'location')) return fields.location || null;
  if (fields.location) return fields.location;
  if (Array.isArray(fields.locationLabels) && fields.locationLabels.length) {
    return fields.locationLabels.join('; ');
  }
  return candidate?.summary?.location || null;
};

const normalizedIdentityText = value => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

export const candidateStart = candidate => {
  const value = effectiveReviewFields(candidate).localStart;
  if (!value) return null;
  const parsed = /[zZ]|[+-]\d{2}:?\d{2}$/.test(String(value))
    ? moment.parseZone(value)
    : moment.tz(value, REVIEW_TIME_ZONE);
  return parsed.isValid() ? parsed : null;
};

export const reviewWindow = (from = new Date()) => {
  const start = moment.tz(from, REVIEW_TIME_ZONE);
  return {
    start,
    end: start.clone().add(REVIEW_HORIZON_MONTHS, 'months').endOf('day'),
  };
};

export const candidateWithinReviewWindow = (candidate, from = new Date()) => {
  if (candidateKind(candidate) !== 'event') return true;
  const start = candidateStart(candidate);
  // A recurring template has no single localStart; the server expands and
  // enforces the same two-month horizon when it is approved.
  if (!start) return true;
  const window = reviewWindow(from);
  return start.isAfter(window.start) && !start.isAfter(window.end);
};

const fallbackSeriesKey = candidate => {
  const start = candidateStart(candidate);
  if (!start) return null;
  const parts = [
    candidateDocumentKey(candidate),
    normalizedIdentityText(candidateTitle(candidate)),
    normalizedIdentityText(candidateLocation(candidate)),
    start.tz(REVIEW_TIME_ZONE).format('HH:mm'),
  ];
  return parts.every(Boolean) ? `client-series:${parts.join('|')}` : null;
};

const candidateSeriesKey = candidate => {
  if (candidate?.recurringSeriesKey) {
    return `worker-series:${candidateDocumentKey(candidate)}:${candidate.recurringSeriesKey}`;
  }
  if (candidate?.parentSourceItemKey) {
    return `parent-series:${candidateDocumentKey(candidate)}:${candidate.parentSourceItemKey}`;
  }
  return fallbackSeriesKey(candidate);
};

export const previewForCandidate = (previews, candidateId) => (
  previews instanceof Map ? previews.get(String(candidateId)) : previews?.[String(candidateId)]
);

export const currentResearchFor = candidate => {
  const research = candidate?.research;
  if (!research) return null;
  const candidateRevision = Number.isInteger(candidate.editorialRevision)
    ? candidate.editorialRevision
    : 0;
  const researchRevision = Number.isInteger(research.basis?.editorialRevision)
    ? research.basis.editorialRevision
    : 0;
  const sameObservation = !candidate.observationId
    || research.basis?.observationId === candidate.observationId;
  return candidateRevision === researchRevision && sameObservation ? research : null;
};

export const previewRequestBasisFor = candidate => ([
  String(candidate?._id || ''),
  String(candidate?.observationId || ''),
  String(Number.isInteger(candidate?.editorialRevision) ? candidate.editorialRevision : 0),
  String(candidate?.validationState || ''),
  String(candidate?.editorialEditToken || ''),
].join(':'));

const compareUnits = (left, right) => {
  const leftStart = candidateStart(left.candidates[0]);
  const rightStart = candidateStart(right.candidates[0]);
  if (leftStart && rightStart) return leftStart.valueOf() - rightStart.valueOf();
  if (leftStart) return -1;
  if (rightStart) return 1;
  return candidateTitle(left.candidates[0]).localeCompare(candidateTitle(right.candidates[0]));
};

/**
 * Collapse dated copies of the same source/title/location/time into one
 * review unit. Candidates remain separate durable decisions; this is only the
 * single-page editorial shape used to invoke the bounded series method.
 */
export const buildReviewUnits = (candidates, previews = {}, from = new Date()) => {
  const groups = new Map();
  let outsideWindow = 0;

  candidates.forEach(candidate => {
    if (!candidateWithinReviewWindow(candidate, from)) {
      outsideWindow += 1;
      return;
    }
    const preview = previewForCandidate(previews, candidate._id);
    const datedEvent = candidateKind(candidate) === 'event' && Boolean(candidateStart(candidate));
    const seriesKey = datedEvent
      ? (candidateSeriesKey(candidate) || preview?.seriesKey)
      : null;
    const key = seriesKey ? `series:${seriesKey}` : `candidate:${candidate._id}`;
    const existing = groups.get(key) || { id: key, seriesKey, candidates: [] };
    existing.candidates.push(candidate);
    groups.set(key, existing);
  });

  const units = [...groups.values()].map(unit => ({
    ...unit,
    candidates: unit.candidates.sort((left, right) => {
      const leftStart = candidateStart(left);
      const rightStart = candidateStart(right);
      return (leftStart?.valueOf() || 0) - (rightStart?.valueOf() || 0);
    }),
  })).sort(compareUnits);

  return { units, outsideWindow };
};

/**
 * Describe the queue an administrator can actually finish today. The durable
 * backlog is deliberately retained, but dated event occurrences outside the
 * rolling publication horizon do not inflate the actionable review count.
 */
export const pendingReviewQueueSummary = (
  candidates,
  from = new Date(),
  previews = {},
) => {
  const pendingCandidates = candidates.filter(candidate => candidate.reviewStatus === 'PENDING');
  const model = buildReviewUnits(pendingCandidates, previews, from);
  return {
    actionableReviewUnits: model.units.length,
    inWindowPendingCandidates: pendingCandidates.length - model.outsideWindow,
    outsideWindowPendingCandidates: model.outsideWindow,
    totalPendingCandidates: pendingCandidates.length,
  };
};

export const duplicateLevelForUnit = (unit, previews = {}) => {
  const levels = unit.candidates
    .map(candidate => previewForCandidate(previews, candidate._id)?.duplicateLevel)
    .filter(Boolean);
  if (!levels.length) return 'PENDING';
  if (levels.includes('BLOCK')) return 'BLOCK';
  if (levels.includes('REVIEW')) return 'REVIEW';
  if (levels.every(level => level === 'NONE')) return 'NONE';
  return 'PENDING';
};

export const effectiveClassificationForUnit = (unit, previews = {}) => {
  const representative = unit.candidates[0];
  return previewForCandidate(previews, representative._id)?.effectiveClassification
    || representative.classificationSuggestion
    || null;
};

export const projectionSummaryForUnit = (unit, previews = {}) => {
  let projectedRecordCount = 0;
  let projectionKnown = true;
  const dates = [];

  unit.candidates.forEach(candidate => {
    const preview = previewForCandidate(previews, candidate._id);
    if (Number.isInteger(preview?.projectedOccurrenceCount)
        && preview.projectedOccurrenceCount >= 0) {
      projectedRecordCount += preview.projectedOccurrenceCount;
    } else if (candidateKind(candidate) === 'group' || candidateStart(candidate)) {
      projectedRecordCount += 1;
    } else {
      projectionKnown = false;
    }
    [preview?.projectedFirstDate, preview?.projectedLastDate]
      .filter(Boolean)
      .forEach(value => {
        const parsed = moment(value);
        if (parsed.isValid()) dates.push(parsed);
      });
  });

  if (!dates.length) {
    unit.candidates.map(candidateStart).filter(Boolean).forEach(date => dates.push(date));
  }
  dates.sort((left, right) => left.valueOf() - right.valueOf());
  return {
    projectedRecordCount: projectionKnown ? projectedRecordCount : null,
    projectedFirstDate: dates[0]?.toDate() || null,
    projectedLastDate: dates[dates.length - 1]?.toDate() || null,
  };
};

export const previewCandidateIdsForUnit = unit => {
  const ids = unit.candidates.map(candidate => String(candidate._id));
  if (ids.length <= 3) return ids;
  return [...new Set([ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]])];
};
