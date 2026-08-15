import { Mongo } from 'meteor/mongo';
import {
  CommunitySources,
  IngestionCandidates,
  SourceHealth,
  SourceRuns,
} from '../IngestionData';

/**
 * Raw ingestion evidence is server-only by construction.
 *
 * Do not move these collections into a client-imported module and do not add
 * publications for them. Raw response metadata, evidence excerpts, and
 * allowlisted source fields belong behind the review boundary.
 */
export const SourcePolicyAssessments = new Mongo.Collection('source_policy_assessments');
export const SourceCursors = new Mongo.Collection('source_cursors');
export const FetchArtifacts = new Mongo.Collection('fetch_artifacts');
export const ParseRuns = new Mongo.Collection('parse_runs');
export const SourceObservations = new Mongo.Collection('source_observations');
export const FieldAssertions = new Mongo.Collection('field_assertions');
export const SourceEntityKeys = new Mongo.Collection('source_entity_keys');
export const ReviewItems = new Mongo.Collection('review_items');

const createIndex = (collection, keys, options = {}) => (
  collection.rawCollection().createIndex(keys, options)
);

/** Create the idempotency and operator-query indexes shared with the worker. */
export const ensureIngestionIndexes = async () => Promise.all([
  createIndex(CommunitySources, { slug: 1 }, { unique: true }),
  createIndex(CommunitySources, { enabled: 1, permission: 1, nextRunAt: 1 }),
  createIndex(SourcePolicyAssessments, { sourceId: 1, revision: 1 }, { unique: true }),
  createIndex(SourceRuns, { sourceId: 1, scheduledFor: 1 }, { unique: true }),
  createIndex(SourceRuns, { status: 1, leaseUntil: 1 }),
  createIndex(SourceCursors, { sourceId: 1 }, { unique: true }),
  createIndex(FetchArtifacts, { sourceId: 1, contentHash: 1 }, { unique: true }),
  createIndex(ParseRuns, { artifactId: 1, parserId: 1, parserVersion: 1 }, { unique: true }),
  createIndex(
    SourceObservations,
    { sourceId: 1, sourceItemKey: 1, itemContentHash: 1, parserVersion: 1 },
    { unique: true },
  ),
  createIndex(FieldAssertions, { canonicalId: 1, fieldPath: 1, status: 1 }),
  createIndex(IngestionCandidates, { fingerprint: 1 }, { unique: true }),
  createIndex(IngestionCandidates, { blockingKeys: 1 }),
  createIndex(IngestionCandidates, { sourceId: 1, reviewStatus: 1, createdAt: -1 }),
  createIndex(IngestionCandidates, { reviewLane: 1, reviewStatus: 1, createdAt: -1 }),
  createIndex(SourceEntityKeys, { sourceId: 1, keyType: 1, keyHash: 1 }, { unique: true }),
  createIndex(ReviewItems, { status: 1, priority: -1, createdAt: 1 }),
  createIndex(ReviewItems, { reviewLane: 1, status: 1, priority: -1, createdAt: 1 }),
  createIndex(SourceHealth, { sourceId: 1 }, { unique: true }),
]);
