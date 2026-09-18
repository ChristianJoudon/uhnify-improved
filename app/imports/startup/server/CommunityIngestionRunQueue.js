import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Random } from 'meteor/random';
import { Roles } from 'meteor/alanning:roles';
import {
  CommunitySources,
  SourceHealth,
} from '../../api/ingestion/IngestionData';
import {
  INGESTION_RECENT_POLICY,
  INGESTION_RECENT_WINDOW_MS,
  INGESTION_RUN_ACTIVE_GUARD,
  INGESTION_RUN_EXECUTION_MODE,
  INGESTION_RUN_REQUEST_CONTRACT_VERSION,
  INGESTION_RUN_REQUEST_METHODS,
  INGESTION_RUN_REQUEST_PUBLICATION,
  INGESTION_RUN_REQUEST_STATUS,
  IngestionRunRequests,
} from '../../api/ingestion/IngestionRunRequests';

/* eslint-disable no-console */

const SOURCE_ID = /^(SRC|SEN)-\d{3}$/;
const SOURCE_SCOPE = 'SOURCE';
const ALL_SCOPE = 'ALL';

const requireAdmin = userId => {
  if (!userId) {
    throw new Meteor.Error('not-logged-in', 'You must be signed in to run community intake.');
  }
  if (!Roles.userIsInRole(userId, 'admin')) {
    throw new Meteor.Error('not-authorized', 'You must be an administrator to run community intake.');
  }
};

const sourceIdentifier = source => String(source?.sourceId || source?.id || source?._id || '');

const registeredSource = sourceId => CommunitySources.findOne({
  $or: [{ _id: sourceId }, { id: sourceId }, { sourceId }],
});

const executionModeFor = sourceId => {
  if (sourceId.startsWith('SEN-')) {
    return INGESTION_RUN_EXECUTION_MODE.manual;
  }
  // What the registry says about the source decides how it runs: cleared for
  // automation means a real run, anything else a probe. This always said
  // "practice", and the worker refuses a practice run of a cleared source.
  const source = registeredSource(sourceId);
  return source?.permission === 'AUTOMATED_ALLOWED' && source.enabled
    ? INGESTION_RUN_EXECUTION_MODE.automatic
    : INGESTION_RUN_EXECUTION_MODE.practice;
};

const dateOrNull = value => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const lastAttemptFor = sourceId => {
  const health = SourceHealth.findOne({
    $or: [{ _id: sourceId }, { sourceId }],
  }, { fields: { lastAttemptAt: 1 } });
  return dateOrNull(health?.lastAttemptAt);
};

const isDuplicateKey = error => (
  error?.code === 11000
  || error?.error === 11000
  || String(error?.message || '').includes('E11000')
);

const resultFor = request => ({
  requestId: String(request._id),
  sourceId: request.sourceId,
  executionMode: request.executionMode,
  status: request.status,
  ...(request.lastAttemptAt ? { lastAttemptAt: request.lastAttemptAt } : {}),
  ...(request.activeRequestId ? { activeRequestId: request.activeRequestId } : {}),
});

const insertDecision = (base, status, extra = {}) => {
  const request = {
    ...base,
    status,
    finishedAt: base.requestedAt,
    updatedAt: base.requestedAt,
    ...extra,
  };
  request._id = IngestionRunRequests.insert(request);
  return resultFor(request);
};

const activeRequestFor = sourceId => IngestionRunRequests.findOne({
  sourceId,
  activeGuard: INGESTION_RUN_ACTIVE_GUARD,
}, { fields: { _id: 1 } });

const insertAlreadyRunning = (base, activeRequest = activeRequestFor(base.sourceId)) => insertDecision(
  base,
  INGESTION_RUN_REQUEST_STATUS.alreadyRunning,
  activeRequest?._id ? { activeRequestId: String(activeRequest._id) } : {},
);

const enqueueSource = ({
  batchId,
  recentCutoff,
  recentPolicy,
  requestScope,
  requestedAt,
  requestedBy,
  sourceId,
}) => {
  const executionMode = executionModeFor(sourceId);
  const lastAttemptAt = lastAttemptFor(sourceId);
  const base = {
    batchId,
    sourceId,
    executionMode,
    requestScope,
    recentPolicy,
    recentCutoff,
    requestedBy,
    requestedAt,
    contractVersion: INGESTION_RUN_REQUEST_CONTRACT_VERSION,
    createdAt: requestedAt,
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
  };

  const activeRequest = activeRequestFor(sourceId);
  if (activeRequest) return insertAlreadyRunning(base, activeRequest);

  if (recentPolicy === INGESTION_RECENT_POLICY.skip
      && lastAttemptAt
      && lastAttemptAt.getTime() >= recentCutoff.getTime()) {
    return insertDecision(base, INGESTION_RUN_REQUEST_STATUS.skippedRecent);
  }

  const queued = {
    ...base,
    status: INGESTION_RUN_REQUEST_STATUS.queued,
    activeGuard: INGESTION_RUN_ACTIVE_GUARD,
    availableAt: requestedAt,
    attempts: 0,
    updatedAt: requestedAt,
  };

  try {
    queued._id = IngestionRunRequests.insert(queued);
    return resultFor(queued);
  } catch (error) {
    // The unique partial index is the authority. The pre-check above improves
    // the ordinary response, while this branch closes simultaneous-click races.
    if (!isDuplicateKey(error)) throw error;
    return insertAlreadyRunning(base);
  }
};

const totalsFor = requests => ({
  requested: requests.length,
  queued: requests.filter(request => request.status === INGESTION_RUN_REQUEST_STATUS.queued).length,
  skippedRecent: requests.filter(
    request => request.status === INGESTION_RUN_REQUEST_STATUS.skippedRecent,
  ).length,
  alreadyRunning: requests.filter(
    request => request.status === INGESTION_RUN_REQUEST_STATUS.alreadyRunning,
  ).length,
});

const enqueueBatch = ({ sourceIds, recentPolicy, requestScope, requestedBy }) => {
  const requestedAt = new Date();
  const recentCutoff = new Date(requestedAt.getTime() - INGESTION_RECENT_WINDOW_MS);
  const batchId = Random.id();
  const requests = sourceIds.map(sourceId => enqueueSource({
    batchId,
    recentCutoff,
    recentPolicy,
    requestScope,
    requestedAt,
    requestedBy,
    sourceId,
  }));
  return {
    batchId,
    requestedAt,
    recentCutoff,
    recentPolicy,
    totals: totalsFor(requests),
    requests,
  };
};

Meteor.methods({
  [INGESTION_RUN_REQUEST_METHODS.requestSource](sourceId, recentPolicy = INGESTION_RECENT_POLICY.skip) {
    requireAdmin(this.userId);
    check(sourceId, String);
    check(recentPolicy, Match.OneOf(
      INGESTION_RECENT_POLICY.skip,
      INGESTION_RECENT_POLICY.rerun,
    ));
    if (!SOURCE_ID.test(sourceId)) {
      throw new Meteor.Error('invalid-source-id', 'Community source ids must use SRC-### or SEN-###.');
    }
    if (!registeredSource(sourceId)) {
      throw new Meteor.Error('source-not-found', 'That community source is not registered.');
    }
    return enqueueBatch({
      sourceIds: [sourceId],
      recentPolicy,
      requestScope: SOURCE_SCOPE,
      requestedBy: this.userId,
    });
  },

  [INGESTION_RUN_REQUEST_METHODS.requestAll](recentPolicy = INGESTION_RECENT_POLICY.skip) {
    requireAdmin(this.userId);
    check(recentPolicy, Match.OneOf(
      INGESTION_RECENT_POLICY.skip,
      INGESTION_RECENT_POLICY.rerun,
    ));
    const sourceIds = [...new Set(
      CommunitySources.find({}, { fields: { _id: 1, id: 1, sourceId: 1 } })
        .fetch()
        .map(sourceIdentifier)
        .filter(sourceId => SOURCE_ID.test(sourceId)),
    )].sort();
    return enqueueBatch({
      sourceIds,
      recentPolicy,
      requestScope: ALL_SCOPE,
      requestedBy: this.userId,
    });
  },
});

Meteor.publish(INGESTION_RUN_REQUEST_PUBLICATION, function () {
  if (!this.userId || !Roles.userIsInRole(this.userId, 'admin')) return this.ready();
  return IngestionRunRequests.find({}, {
    fields: {
      _id: 1,
      batchId: 1,
      sourceId: 1,
      executionMode: 1,
      requestScope: 1,
      recentPolicy: 1,
      status: 1,
      requestedAt: 1,
      lastAttemptAt: 1,
      activeRequestId: 1,
      availableAt: 1,
      startedAt: 1,
      finishedAt: 1,
      leaseUntil: 1,
      attempts: 1,
      resultRunId: 1,
      completeness: 1,
      metrics: 1,
      errorCode: 1,
    },
    sort: { requestedAt: -1 },
    limit: 500,
  });
});

export const ensureIngestionRunRequestIndexes = async () => Promise.all([
  IngestionRunRequests.rawCollection().createIndex(
    { batchId: 1, sourceId: 1 },
    { unique: true, name: 'ingestion_run_requests_one_source_per_batch' },
  ),
  IngestionRunRequests.rawCollection().createIndex(
    { sourceId: 1, activeGuard: 1 },
    {
      unique: true,
      name: 'ingestion_run_requests_one_active_source',
      partialFilterExpression: { activeGuard: INGESTION_RUN_ACTIVE_GUARD },
    },
  ),
  IngestionRunRequests.rawCollection().createIndex(
    { status: 1, availableAt: 1, leaseUntil: 1, requestedAt: 1 },
    { name: 'ingestion_run_requests_worker_claim' },
  ),
  IngestionRunRequests.rawCollection().createIndex(
    { sourceId: 1, requestedAt: -1 },
    { name: 'ingestion_run_requests_source_history' },
  ),
]);

Meteor.startup(() => {
  ensureIngestionRunRequestIndexes().catch(error => {
    console.error('[ingestion] run-request indexes failed:', error.message);
  });
});
