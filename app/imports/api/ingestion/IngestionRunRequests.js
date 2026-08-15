import { Mongo } from 'meteor/mongo';

/**
 * Durable hand-off between the Meteor admin controls and the standalone
 * community-ingestion worker.
 *
 * Meteor may enqueue work, but it never receives a URL, command, filesystem
 * path, or adapter name from the browser. The worker resolves the registered
 * source by sourceId and derives everything else from the governed registry.
 */
export const IngestionRunRequests = new Mongo.Collection('ingestion_run_requests');

export const INGESTION_RUN_REQUEST_PUBLICATION = 'ingestion.runRequests.admin';

export const INGESTION_RUN_REQUEST_METHODS = Object.freeze({
  requestSource: 'ingestion.runs.requestSource',
  requestAll: 'ingestion.runs.requestAll',
});

export const INGESTION_RUN_REQUEST_STATUS = Object.freeze({
  queued: 'QUEUED',
  running: 'RUNNING',
  succeeded: 'SUCCEEDED',
  failed: 'FAILED',
  skippedRecent: 'SKIPPED_RECENT',
  alreadyRunning: 'ALREADY_RUNNING',
});

export const INGESTION_RUN_EXECUTION_MODE = Object.freeze({
  practice: 'PRACTICE',
  manual: 'MANUAL',
});

export const INGESTION_RECENT_POLICY = Object.freeze({
  skip: 'SKIP',
  rerun: 'RERUN',
});

export const INGESTION_RUN_REQUEST_CONTRACT_VERSION = 'ingestion-run-request.v1';
export const INGESTION_RUN_ACTIVE_GUARD = 'ACTIVE';
export const INGESTION_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Selector the standalone worker uses for an atomic findOneAndUpdate claim.
 *
 * A QUEUED request becomes claimable at availableAt. A RUNNING request becomes
 * claimable again only after its lease expires, so a worker or host restart
 * cannot strand it permanently. A claimant must replace leaseOwner and
 * leaseToken, extend leaseUntil, and increment attempts in the same atomic
 * update. Completion must match both leaseOwner and leaseToken before unsetting
 * activeGuard; this prevents an expired worker from completing a reclaimed job.
 */
export const claimableIngestionRunRequestSelector = now => ({
  activeGuard: INGESTION_RUN_ACTIVE_GUARD,
  $or: [
    {
      status: INGESTION_RUN_REQUEST_STATUS.queued,
      availableAt: { $lte: now },
    },
    {
      status: INGESTION_RUN_REQUEST_STATUS.running,
      leaseUntil: { $lte: now },
    },
  ],
});

/** Only these outcomes retain the per-source active guard. */
export const ACTIVE_INGESTION_RUN_REQUEST_STATUSES = Object.freeze([
  INGESTION_RUN_REQUEST_STATUS.queued,
  INGESTION_RUN_REQUEST_STATUS.running,
]);

/** These outcomes are decisions or completed worker attempts. */
export const TERMINAL_INGESTION_RUN_REQUEST_STATUSES = Object.freeze([
  INGESTION_RUN_REQUEST_STATUS.succeeded,
  INGESTION_RUN_REQUEST_STATUS.failed,
  INGESTION_RUN_REQUEST_STATUS.skippedRecent,
  INGESTION_RUN_REQUEST_STATUS.alreadyRunning,
]);
