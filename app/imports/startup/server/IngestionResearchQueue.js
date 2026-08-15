import crypto from 'crypto';
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Random } from 'meteor/random';
import { Roles } from 'meteor/alanning:roles';
import {
  CommunitySources,
  IngestionCandidates,
} from '../../api/ingestion/IngestionData';
import {
  INGESTION_RESEARCH_CONTRACT_VERSION,
  INGESTION_RESEARCH_CANDIDATE_ACTIVE_GUARD,
  INGESTION_RESEARCH_EXECUTION_MODE,
  INGESTION_RESEARCH_MAX_QUEUE_ATTEMPTS,
  INGESTION_RESEARCH_METHODS,
  INGESTION_RESEARCH_PUBLICATION,
  INGESTION_RESEARCH_REQUEST_SCOPE,
  INGESTION_RESEARCH_REQUEST_STATUS,
  INGESTION_RESEARCH_STATUS,
  INGESTION_WORKER_HEALTH_PUBLICATION,
  IngestionWorkerHealth,
} from '../../api/ingestion/IngestionResearch';
import {
  INGESTION_RUN_ACTIVE_GUARD,
  INGESTION_RUN_REQUEST_CONTRACT_VERSION,
  INGESTION_RUN_REQUEST_STATUS,
  IngestionRunRequests,
} from '../../api/ingestion/IngestionRunRequests';

/* eslint-disable no-console */

const CANDIDATE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CACHEABLE_RESEARCH_STATUSES = new Set([
  INGESTION_RESEARCH_STATUS.succeeded,
  INGESTION_RESEARCH_STATUS.partial,
]);

const requireAdmin = userId => {
  if (!userId) {
    throw new Meteor.Error('not-logged-in', 'You must be signed in to research an intake candidate.');
  }
  if (!Roles.userIsInRole(userId, 'admin')) {
    throw new Meteor.Error('not-authorized', 'You must be an administrator to research an intake candidate.');
  }
};

const registeredSource = sourceId => CommunitySources.findOne({
  $or: [{ _id: sourceId }, { id: sourceId }, { sourceId }],
}, { fields: { _id: 1, id: 1, sourceId: 1 } });

const editorialRevisionFor = candidate => (
  Number.isInteger(candidate?.editorialRevision) && candidate.editorialRevision >= 0
    ? candidate.editorialRevision
    : 0
);

export const candidateResearchBasisKey = (fingerprint, editorialRevision) => (
  crypto.createHash('sha256').update(`${fingerprint}\n${editorialRevision}`).digest('hex')
);

const researchBasisFor = candidate => {
  const editorialRevision = editorialRevisionFor(candidate);
  return {
    candidateFingerprint: candidate.fingerprint,
    observationId: candidate.observationId,
    editorialRevision,
    basisKey: candidateResearchBasisKey(candidate.fingerprint, editorialRevision),
  };
};

const hasValue = value => {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
};

const venueClue = /\b(?:beach|church|chapel|temple|park|library|school|campus|center|centre|hall|clubhouse|theater|theatre|museum|garden|market|farm|resort|hotel|cafe|coffee|restaurant|arena|gym|studio|clinic|hospital)\b/i;
const streetOrPostalSignal = /(?:\b\d{1,6}\s+\S|\b(?:967\d{2})\b|\b(?:street|road|avenue|highway|drive|lane|boulevard|place|way)\b)/i;

const firstText = value => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!Array.isArray(value)) return null;
  return value.find(item => typeof item === 'string' && item.trim())?.trim() || null;
};

const dateTimestamp = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const validEventEnd = (start, end) => {
  const startAt = dateTimestamp(start);
  const endAt = dateTimestamp(end);
  if (startAt === null || endAt === null) return false;
  const duration = endAt - startAt;
  return duration > 0 && duration <= 24 * 60 * 60 * 1000;
};

const eventScheduleResearchField = fields => {
  const scheduleResearchRequested = Array.isArray(fields.researchNeeded)
    && fields.researchNeeded.includes('schedule');
  if (hasValue(fields.recurrenceLabel)) {
    return scheduleResearchRequested ? 'recurrenceLabel' : null;
  }
  if (dateTimestamp(fields.localStart) === null) return 'localStart';
  if (hasValue(fields.localEnd) && !validEventEnd(fields.localStart, fields.localEnd)) {
    return 'localEnd';
  }
  return scheduleResearchRequested ? 'localEnd' : null;
};

const researchEffectiveNormalizedFields = candidate => {
  const fields = { ...(candidate.normalizedFields || {}) };
  const overrides = candidate.editorialOverrides || {};
  if (typeof overrides.title === 'string' && overrides.title.trim()) fields.title = overrides.title;
  if (typeof overrides.location === 'string' && overrides.location.trim()) {
    fields.location = overrides.location;
    fields.locationLabels = [overrides.location];
    fields.__matchbookCuratorLocationConfirmed = true;
  }
  const schedule = overrides.schedule || {};
  if (schedule.kind === 'ONE_TIME'
    && typeof schedule.localStart === 'string'
    && schedule.localStart.trim()) {
    fields.localStart = schedule.localStart;
    if (typeof schedule.localEnd === 'string' && schedule.localEnd.trim()) fields.localEnd = schedule.localEnd;
    else delete fields.localEnd;
    delete fields.recurrenceLabel;
    fields.recurrenceLabels = [];
  } else if (schedule.kind === 'RECURRENCE'
    && typeof schedule.recurrenceLabel === 'string'
    && schedule.recurrenceLabel.trim()) {
    fields.recurrenceLabel = schedule.recurrenceLabel;
    fields.recurrenceLabels = [schedule.recurrenceLabel];
    delete fields.localStart;
    delete fields.localEnd;
  }
  return fields;
};

const missingFieldsFor = candidate => {
  const fields = researchEffectiveNormalizedFields(candidate);
  const missing = [];
  if (!hasValue(fields.title)) missing.push('title');
  const location = firstText(fields.location) || firstText(fields.locationLabels);
  if (!hasValue(location)
    || (fields.__matchbookCuratorLocationConfirmed !== true
      && venueClue.test(location)
      && !streetOrPostalSignal.test(location))) missing.push('location');
  if (candidate.entityHint === 'group') {
    const scheduleResearchRequested = Array.isArray(fields.researchNeeded)
      && fields.researchNeeded.includes('schedule');
    if (!hasValue(fields.recurrenceLabel) || scheduleResearchRequested) {
      missing.push('recurrenceLabel');
    }
  } else {
    const scheduleField = eventScheduleResearchField(fields);
    if (scheduleField) missing.push(scheduleField);
  }
  return missing;
};

const resultFor = request => ({
  requestId: String(request._id),
  candidateId: request.candidateId,
  sourceId: request.sourceId,
  executionMode: request.executionMode,
  status: request.status,
  ...(request.activeRequestId ? { activeRequestId: request.activeRequestId } : {}),
  ...(request.cachedRequestId ? { cachedRequestId: request.cachedRequestId } : {}),
  ...(request.busyScope ? { busyScope: request.busyScope } : {}),
  ...(request.retryable === true ? { retryable: true } : {}),
  ...(request.availableAt ? { availableAt: request.availableAt } : {}),
  ...(Number.isInteger(request.attempts) ? { attempts: request.attempts } : {}),
  ...(Number.isInteger(request.maxAttempts) ? { maxAttempts: request.maxAttempts } : {}),
});

const activeCandidateRequestFor = (candidateId, basisKey) => IngestionRunRequests.findOne({
  candidateId,
  executionMode: INGESTION_RESEARCH_EXECUTION_MODE,
  researchBasisKey: basisKey,
  status: { $in: [
    INGESTION_RUN_REQUEST_STATUS.queued,
    INGESTION_RUN_REQUEST_STATUS.running,
  ] },
}, {
  fields: {
    _id: 1,
    status: 1,
    availableAt: 1,
    attempts: 1,
    maxAttempts: 1,
  },
  sort: { requestedAt: 1 },
});

const activeSourceRequestFor = sourceId => IngestionRunRequests.findOne({
  sourceId,
  activeGuard: INGESTION_RUN_ACTIVE_GUARD,
}, { fields: { _id: 1 } });

const isDuplicateKey = error => (
  error?.code === 11000
  || error?.error === 11000
  || String(error?.message || '').includes('E11000')
);

const insertDecision = (base, status, extra = {}) => {
  const request = {
    ...base,
    status,
    finishedAt: base.requestedAt,
    updatedAt: base.requestedAt,
    ...extra,
  };
  IngestionRunRequests.insert(request);
  return resultFor(request);
};

const candidateSelector = (candidate, basis) => ({
  _id: candidate._id,
  fingerprint: basis.candidateFingerprint,
  observationId: basis.observationId,
  ...(basis.editorialRevision === 0
    ? { $or: [{ editorialRevision: 0 }, { editorialRevision: { $exists: false } }] }
    : { editorialRevision: basis.editorialRevision }),
});

const cachedResearchRequestId = (candidate, basis) => {
  const research = candidate.research;
  if (!research
    || !CACHEABLE_RESEARCH_STATUSES.has(research.status)
    || research.retryable === true
    || research.basis?.basisKey !== basis.basisKey
    || research.basis?.observationId !== basis.observationId) return null;
  const coveredFields = new Set([
    ...(Array.isArray(research.missingFields) ? research.missingFields : []),
    ...(Array.isArray(research.fieldSuggestions)
      ? research.fieldSuggestions.map(suggestion => suggestion?.field).filter(Boolean)
      : []),
  ]);
  if (missingFieldsFor(candidate).some(field => !coveredFields.has(field))) return null;
  return typeof research.requestId === 'string' ? research.requestId : null;
};

const enqueueResearch = (candidate, requestedBy) => {
  const sourceId = candidate.sourceId;
  const requestedAt = new Date();
  const requestId = Random.id();
  const basis = researchBasisFor(candidate);
  const base = {
    _id: requestId,
    batchId: requestId,
    candidateId: String(candidate._id),
    sourceId,
    executionMode: INGESTION_RESEARCH_EXECUTION_MODE,
    requestScope: INGESTION_RESEARCH_REQUEST_SCOPE,
    candidateFingerprint: basis.candidateFingerprint,
    candidateObservationId: basis.observationId,
    candidateEditorialRevision: basis.editorialRevision,
    researchBasisKey: basis.basisKey,
    requestedBy,
    requestedAt,
    createdAt: requestedAt,
    contractVersion: INGESTION_RUN_REQUEST_CONTRACT_VERSION,
    researchContractVersion: INGESTION_RESEARCH_CONTRACT_VERSION,
    maxAttempts: INGESTION_RESEARCH_MAX_QUEUE_ATTEMPTS,
  };

  const cachedRequestId = cachedResearchRequestId(candidate, basis);
  if (cachedRequestId) {
    return insertDecision(base, INGESTION_RESEARCH_REQUEST_STATUS.alreadyCurrent, {
      cachedRequestId,
    });
  }

  const activeRequest = activeCandidateRequestFor(String(candidate._id), basis.basisKey);
  if (activeRequest?._id) {
    return insertDecision(base, INGESTION_RESEARCH_REQUEST_STATUS.alreadyRunning, {
      activeRequestId: String(activeRequest._id),
      busyScope: 'CANDIDATE',
      retryable: true,
      availableAt: activeRequest.availableAt,
      attempts: activeRequest.attempts,
      maxAttempts: activeRequest.maxAttempts,
    });
  }

  const request = {
    ...base,
    status: INGESTION_RUN_REQUEST_STATUS.queued,
    candidateActiveGuard: INGESTION_RESEARCH_CANDIDATE_ACTIVE_GUARD,
    availableAt: requestedAt,
    attempts: 0,
    updatedAt: requestedAt,
  };
  const sourceRequest = activeSourceRequestFor(sourceId);
  if (sourceRequest?._id) {
    request.busyScope = 'SOURCE';
    request.waitingOnSourceRequestId = String(sourceRequest._id);
  }
  try {
    IngestionRunRequests.insert(request);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const winner = activeCandidateRequestFor(String(candidate._id), basis.basisKey);
    return insertDecision(base, INGESTION_RESEARCH_REQUEST_STATUS.alreadyRunning, {
      ...(winner?._id ? { activeRequestId: String(winner._id) } : {}),
      busyScope: 'CANDIDATE',
      retryable: true,
      availableAt: winner?.availableAt,
      attempts: winner?.attempts,
      maxAttempts: winner?.maxAttempts,
    });
  }
  const changed = IngestionCandidates.update(candidateSelector(candidate, basis), {
    $set: {
      research: {
        contractVersion: INGESTION_RESEARCH_CONTRACT_VERSION,
        requestId,
        status: INGESTION_RESEARCH_STATUS.queued,
        basis,
        missingFields: missingFieldsFor(candidate),
        attempts: [],
        evidence: [],
        fieldSuggestions: [],
        queue: {
          status: INGESTION_RESEARCH_STATUS.queued,
          attemptCount: 0,
          maxAttempts: INGESTION_RESEARCH_MAX_QUEUE_ATTEMPTS,
          availableAt: requestedAt,
          progressStage: sourceRequest ? 'WAITING_FOR_SOURCE' : 'WAITING_FOR_WORKER',
          progressMessage: sourceRequest
            ? 'Queued behind another job for this source; this candidate will not be discarded.'
            : 'Waiting for an ingestion worker to claim this candidate.',
          updatedAt: requestedAt,
        },
        requestedAt,
        updatedAt: requestedAt,
      },
    },
  });
  if (changed !== 1) {
    IngestionRunRequests.remove({
      _id: requestId,
      status: INGESTION_RUN_REQUEST_STATUS.queued,
    });
    throw new Meteor.Error(
      'ingestion-research-candidate-changed',
      'That candidate changed while research was being queued. Reload and try again.',
    );
  }
  return resultFor(request);
};

Meteor.methods({
  [INGESTION_RESEARCH_METHODS.request](candidateId) {
    requireAdmin(this.userId);
    check(candidateId, String);
    if (!CANDIDATE_ID.test(candidateId)) {
      throw new Meteor.Error('invalid-candidate-id', 'A valid intake candidate id is required.');
    }
    const candidate = IngestionCandidates.findOne(candidateId, {
      fields: {
        _id: 1,
        sourceId: 1,
        sourceItemKey: 1,
        fingerprint: 1,
        observationId: 1,
        editorialRevision: 1,
        editorialOverrides: 1,
        entityHint: 1,
        normalizedFields: 1,
        research: 1,
      },
    });
    if (!candidate) {
      throw new Meteor.Error('candidate-not-found', 'That intake candidate no longer exists.');
    }
    if (candidate.entityHint !== 'event' && candidate.entityHint !== 'group') {
      throw new Meteor.Error('candidate-kind-unsupported', 'Only event and group candidates can be researched.');
    }
    if (typeof candidate.sourceId !== 'string'
      || typeof candidate.sourceItemKey !== 'string'
      || typeof candidate.fingerprint !== 'string'
      || typeof candidate.observationId !== 'string') {
      throw new Meteor.Error('candidate-context-invalid', 'That candidate is missing governed source evidence.');
    }
    if (!registeredSource(candidate.sourceId)) {
      throw new Meteor.Error('source-not-found', 'That candidate source is no longer registered.');
    }
    return enqueueResearch(candidate, this.userId);
  },
});

Meteor.publish(INGESTION_RESEARCH_PUBLICATION, function () {
  if (!this.userId || !Roles.userIsInRole(this.userId, 'admin')) return this.ready();
  return IngestionCandidates.find({ research: { $exists: true } }, {
    fields: {
      _id: 1,
      'research.contractVersion': 1,
      'research.requestId': 1,
      'research.status': 1,
      'research.basis.observationId': 1,
      'research.basis.editorialRevision': 1,
      'research.basis.basisKey': 1,
      'research.missingFields': 1,
      'research.queue.status': 1,
      'research.queue.attemptCount': 1,
      'research.queue.maxAttempts': 1,
      'research.queue.availableAt': 1,
      'research.queue.nextAttemptAt': 1,
      'research.queue.leaseUntil': 1,
      'research.queue.lastAttemptAt': 1,
      'research.queue.lastErrorCode': 1,
      'research.queue.lastErrorAt': 1,
      'research.queue.progressStage': 1,
      'research.queue.progressMessage': 1,
      'research.queue.updatedAt': 1,
      'research.attempts.strategy': 1,
      'research.attempts.status': 1,
      'research.attempts.code': 1,
      'research.attempts.startedAt': 1,
      'research.attempts.finishedAt': 1,
      'research.evidence.id': 1,
      'research.evidence.kind': 1,
      'research.evidence.sourceUrl': 1,
      'research.evidence.observedAt': 1,
      'research.evidence.contentHash': 1,
      'research.evidence.fields': 1,
      'research.evidence.basisKey': 1,
      'research.fieldSuggestions.field': 1,
      'research.fieldSuggestions.value': 1,
      'research.fieldSuggestions.confidence': 1,
      'research.fieldSuggestions.reason': 1,
      'research.fieldSuggestions.evidenceIds': 1,
      'research.fieldSuggestions.basisKey': 1,
      'research.retryable': 1,
      'research.searchFallback.availability': 1,
      'research.searchFallback.mode': 1,
      'research.searchFallback.query': 1,
      'research.searchFallback.href': 1,
      'research.searchFallback.provider': 1,
      'research.requestedAt': 1,
      'research.startedAt': 1,
      'research.finishedAt': 1,
      'research.updatedAt': 1,
      'research.errorCode': 1,
    },
    sort: { 'research.updatedAt': -1 },
    limit: 500,
  });
});

Meteor.publish(INGESTION_WORKER_HEALTH_PUBLICATION, function () {
  if (!this.userId || !Roles.userIsInRole(this.userId, 'admin')) return this.ready();
  return IngestionWorkerHealth.find({}, {
    fields: {
      _id: 1,
      contractVersion: 1,
      status: 1,
      startedAt: 1,
      heartbeatAt: 1,
      leaseUntil: 1,
      currentRequestId: 1,
      currentSourceId: 1,
      currentCandidateId: 1,
      currentExecutionMode: 1,
      processed: 1,
      lastCompletedAt: 1,
      lastErrorCode: 1,
      stoppedAt: 1,
    },
    sort: { heartbeatAt: -1 },
    limit: 20,
  });
});

export const ensureIngestionResearchIndexes = async () => Promise.all([
  IngestionCandidates.rawCollection().createIndex(
    { 'research.status': 1, 'research.updatedAt': -1 },
    { name: 'ingestion_candidates_research_status' },
  ),
  IngestionRunRequests.rawCollection().createIndex(
    { candidateId: 1, executionMode: 1, requestedAt: -1 },
    { name: 'ingestion_run_requests_candidate_research_history' },
  ),
  IngestionRunRequests.rawCollection().createIndex(
    { candidateId: 1, researchBasisKey: 1, candidateActiveGuard: 1 },
    {
      unique: true,
      name: 'ingestion_run_requests_one_active_candidate_research',
      partialFilterExpression: {
        candidateActiveGuard: INGESTION_RESEARCH_CANDIDATE_ACTIVE_GUARD,
      },
    },
  ),
  IngestionWorkerHealth.rawCollection().createIndex(
    { leaseUntil: 1 },
    { name: 'ingestion_worker_health_lease' },
  ),
]);

Meteor.startup(() => {
  ensureIngestionResearchIndexes().catch(error => {
    console.error('[ingestion] research indexes failed:', error.message);
  });
});
