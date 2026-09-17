import { Mongo } from 'meteor/mongo';

export const INGESTION_RESEARCH_CONTRACT_VERSION = 'candidate-research.v2';

export const INGESTION_RESEARCH_METHODS = Object.freeze({
  request: 'ingestion.research.request',
});

export const INGESTION_RESEARCH_PUBLICATION = 'ingestion.research.admin';

export const INGESTION_WORKER_HEALTH_PUBLICATION = 'ingestion.workerHealth.admin';

/**
 * Ephemeral operational heartbeats written by the standalone ingestion worker.
 * A row is not a lock or a source of truth for review decisions; clients must
 * consider a worker online only while leaseUntil is still in the future.
 */
export const IngestionWorkerHealth = new Mongo.Collection('ingestion_worker_health');

export const INGESTION_WORKER_HEALTH_CONTRACT_VERSION = 'ingestion-worker-health.v1';

export const INGESTION_WORKER_HEALTH_STATUS = Object.freeze({
  starting: 'STARTING',
  online: 'ONLINE',
  stopping: 'STOPPING',
  offline: 'OFFLINE',
});

export const INGESTION_RESEARCH_EXECUTION_MODE = 'RESEARCH';

export const INGESTION_RESEARCH_REQUEST_SCOPE = 'CANDIDATE_RESEARCH';

export const INGESTION_RESEARCH_REQUEST_STATUS = Object.freeze({
  queued: 'QUEUED',
  alreadyRunning: 'ALREADY_RUNNING',
  alreadyCurrent: 'ALREADY_CURRENT',
});

export const INGESTION_RESEARCH_CANDIDATE_ACTIVE_GUARD = 'ACTIVE';

export const INGESTION_RESEARCH_MAX_QUEUE_ATTEMPTS = 3;

export const INGESTION_RESEARCH_STATUS = Object.freeze({
  queued: 'QUEUED',
  running: 'RUNNING',
  succeeded: 'SUCCEEDED',
  partial: 'PARTIAL',
  unavailable: 'UNAVAILABLE',
  failed: 'FAILED',
});
