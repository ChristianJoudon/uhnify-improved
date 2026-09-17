import { randomUUID } from 'node:crypto';
import type { Collection, Db, Document, MongoClient } from 'mongodb';
import type { ClassificationSuggestion } from './classification.js';
import type { SourceDefinition } from './contracts.js';

type StringIdDocument = Document & { _id: string };

export type RunMetrics = {
  discovered: number;
  emitted: number;
  rejected: number;
  artifactsCreated: number;
  observationsCreated: number;
  candidatesCreated: number;
  unchanged: boolean;
};

export type ArtifactRecord = {
  id: string;
  sourceId: string;
  contentHash: string;
  observedAt: Date;
  byteLength: number;
  mediaType: string;
  sourceUrl: string;
  statusCode: number;
  responseHeaders: Record<string, string>;
  storagePath: string;
};

export type ObservationRecord = {
  id: string;
  sourceId: string;
  runId: string;
  artifactId: string;
  observedAt: Date;
  sourceItemKey: string;
  canonicalSourceUrl: string;
  itemContentHash: string;
  parserId: string;
  parserVersion: string;
  entityHint: 'event' | 'group' | 'organization' | 'venue';
  rawFields: Record<string, unknown>;
  evidence: Array<{
    id: string;
    artifactId: string;
    sourceUrl: string;
    locatorKind: string;
    locator: string;
    excerptHash: string;
    excerpt?: string;
  }>;
  explicitRealityHint?: 'SCHEDULED' | 'POSTPONED' | 'CANCELLED';
};

export type CandidateRecord = {
  id: string;
  sourceId: string;
  sourceItemKey: string;
  entityHint: 'event' | 'group' | 'organization' | 'venue';
  parentSourceItemKey?: string;
  observationId: string;
  fingerprint: string;
  blockingKeys: string[];
  normalizedFields: Record<string, unknown>;
  summary: { title: string; when?: string; location?: string };
  classificationSuggestion?: ClassificationSuggestion;
  recurringSeriesKey?: string;
  validationState: 'VALID' | 'INVALID';
  reviewStatus: 'PENDING' | 'SUPERSEDED' | 'APPROVING' | 'APPROVED' | 'REJECTED';
  reviewLane?: 'SENSITIVE';
  privacyReviewRequired?: boolean;
  sensitivePolicyVersion?: string;
  projectionEligibility?: 'REQUIRES_SENSITIVE_REVIEW';
  createdAt: Date;
  lastObservedAt: Date;
};

const parentSourceItemKeyFromRawFields = (rawFields: unknown): string | undefined => {
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) return undefined;
  const groupKey = (rawFields as Record<string, unknown>).groupKey;
  return typeof groupKey === 'string' ? `group:${groupKey}` : undefined;
};

const REPUBLICATION_STALE_FIELDS = [
  'approvalClaimToken',
  'approvalClaimedAt',
  'approvalClaimedBy',
  'reviewedAt',
  'reviewedBy',
  'publicationState',
  'projectionVersion',
  'projectionReferenceAt',
  'canonicalTargets',
  'lastProjectionErrorCode',
  'supersededAt',
] as const;

const clearStalePublicationState = (candidate: CandidateRecord): void => {
  const mutableCandidate = candidate as unknown as Record<string, unknown>;
  REPUBLICATION_STALE_FIELDS.forEach(field => delete mutableCandidate[field]);
};

const republicationUnset = Object.fromEntries(
  REPUBLICATION_STALE_FIELDS.map(field => [field, '']),
);

export type SourceHealthStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED';

export type SourceHealthRecord = {
  sourceId: string;
  lastAttemptAt: Date;
  lastSuccessAt?: Date;
  lastStatus: SourceHealthStatus;
  lastErrorCode?: string;
  consecutiveFailures: number;
};

export interface IngestionRepository {
  ensureIndexes(): Promise<void>;
  upsertSource(source: SourceDefinition, registryVersion: string): Promise<void>;
  startRun(sourceId: string, scheduledFor: Date): Promise<string>;
  finishRun(runId: string, completeness: 'COMPLETE' | 'PARTIAL', metrics: RunMetrics): Promise<void>;
  failRun(runId: string, code: string): Promise<void>;
  putArtifact(record: ArtifactRecord): Promise<{ id: string; created: boolean }>;
  parseRunCompleteness(
    artifactId: string,
    parserId: string,
    parserVersion: string,
  ): Promise<'COMPLETE' | 'PARTIAL' | null>;
  recordParseRun(
    artifactId: string,
    parserId: string,
    parserVersion: string,
    runId: string,
    completeness: 'COMPLETE' | 'PARTIAL',
  ): Promise<void>;
  putObservation(record: ObservationRecord): Promise<{ id: string; created: boolean }>;
  upsertCandidate(
    record: CandidateRecord,
    legacyRelationshipFingerprint?: string,
  ): Promise<{ id: string; created: boolean }>;
  recordHealth(sourceId: string, status: SourceHealthStatus, errorCode?: string): Promise<void>;
}

type RunState = {
  id: string;
  sourceId: string;
  scheduledFor: Date;
  status: string;
  completeness?: 'COMPLETE' | 'PARTIAL';
  metrics?: RunMetrics;
  errorCode?: string;
};

export class MemoryIngestionRepository implements IngestionRepository {
  readonly sources = new Map<string, SourceDefinition>();
  readonly runs = new Map<string, RunState>();
  readonly artifacts = new Map<string, ArtifactRecord>();
  readonly parseRuns = new Map<string, 'COMPLETE' | 'PARTIAL'>();
  readonly observations = new Map<string, ObservationRecord>();
  readonly candidates = new Map<string, CandidateRecord>();
  readonly health = new Map<string, SourceHealthRecord>();

  async ensureIndexes(): Promise<void> {}

  async upsertSource(source: SourceDefinition): Promise<void> {
    this.sources.set(source.id, source);
  }

  async startRun(sourceId: string, scheduledFor: Date): Promise<string> {
    const id = randomUUID();
    this.runs.set(id, { id, sourceId, scheduledFor, status: 'PARSING' });
    return id;
  }

  async finishRun(runId: string, completeness: 'COMPLETE' | 'PARTIAL', metrics: RunMetrics): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    Object.assign(run, { status: completeness, completeness, metrics });
  }

  async failRun(runId: string, code: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    Object.assign(run, { status: 'FAILED', errorCode: code });
  }

  async putArtifact(record: ArtifactRecord): Promise<{ id: string; created: boolean }> {
    const key = `${record.sourceId}:${record.contentHash}`;
    const existing = this.artifacts.get(key);
    if (existing) return { id: existing.id, created: false };
    this.artifacts.set(key, record);
    return { id: record.id, created: true };
  }

  async parseRunCompleteness(
    artifactId: string,
    parserId: string,
    parserVersion: string,
  ): Promise<'COMPLETE' | 'PARTIAL' | null> {
    return this.parseRuns.get(`${artifactId}:${parserId}:${parserVersion}`) ?? null;
  }

  async recordParseRun(
    artifactId: string,
    parserId: string,
    parserVersion: string,
    _runId: string,
    completeness: 'COMPLETE' | 'PARTIAL',
  ): Promise<void> {
    this.parseRuns.set(`${artifactId}:${parserId}:${parserVersion}`, completeness);
  }

  async putObservation(record: ObservationRecord): Promise<{ id: string; created: boolean }> {
    const key = [record.sourceId, record.sourceItemKey, record.itemContentHash, record.parserVersion].join(':');
    const existing = this.observations.get(key);
    if (existing) return { id: existing.id, created: false };
    this.observations.set(key, record);
    return { id: record.id, created: true };
  }

  async upsertCandidate(
    record: CandidateRecord,
    legacyRelationshipFingerprint?: string,
  ): Promise<{ id: string; created: boolean }> {
    let existing = this.candidates.get(record.fingerprint);
    if (!existing && legacyRelationshipFingerprint && record.parentSourceItemKey) {
      const legacyCandidate = this.candidates.get(legacyRelationshipFingerprint);
      if (legacyCandidate) {
        const legacyObservation = [...this.observations.values()]
          .find(observation => observation.id === legacyCandidate.observationId);
        const legacyParentSourceItemKey = legacyCandidate.parentSourceItemKey
          ?? parentSourceItemKeyFromRawFields(legacyObservation?.rawFields);
        if (legacyParentSourceItemKey === record.parentSourceItemKey) {
          existing = legacyCandidate;
          if (!existing.parentSourceItemKey) existing.parentSourceItemKey = record.parentSourceItemKey;
        }
      }
    }
    const republicationRequired = existing?.reviewStatus === 'APPROVED'
      && [...this.candidates.values()].some(candidate => (
        candidate !== existing
        && candidate.sourceId === record.sourceId
        && candidate.sourceItemKey === record.sourceItemKey
        && candidate.reviewStatus === 'APPROVED'
        && candidate.lastObservedAt.getTime() > existing.lastObservedAt.getTime()
      ));
    for (const candidate of this.candidates.values()) {
      if (candidate.sourceId === record.sourceId
        && candidate.sourceItemKey === record.sourceItemKey
        && candidate !== existing
        && candidate.reviewStatus === 'PENDING') candidate.reviewStatus = 'SUPERSEDED';
    }
    if (existing) {
      existing.observationId = record.observationId;
      existing.lastObservedAt = record.lastObservedAt;
      if (record.classificationSuggestion) {
        existing.classificationSuggestion = record.classificationSuggestion;
      }
      if (record.recurringSeriesKey) existing.recurringSeriesKey = record.recurringSeriesKey;
      if (existing.reviewStatus === 'SUPERSEDED' || republicationRequired) {
        existing.reviewStatus = 'PENDING';
        if (republicationRequired) clearStalePublicationState(existing);
      }
      return { id: existing.id, created: false };
    }
    this.candidates.set(record.fingerprint, record);
    return { id: record.id, created: true };
  }

  async recordHealth(sourceId: string, status: SourceHealthStatus, errorCode?: string): Promise<void> {
    const previous = this.health.get(sourceId);
    const attemptedAt = new Date();
    if (status === 'COMPLETE') {
      this.health.set(sourceId, {
        sourceId,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: attemptedAt,
        lastStatus: status,
        consecutiveFailures: 0,
      });
      return;
    }
    this.health.set(sourceId, {
      sourceId,
      lastAttemptAt: attemptedAt,
      ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
      lastStatus: status,
      ...(errorCode ? { lastErrorCode: errorCode } : {}),
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    });
  }
}

export class MongoIngestionRepository implements IngestionRepository {
  private readonly db: Db;

  constructor(client: MongoClient, databaseName?: string) {
    this.db = client.db(databaseName);
  }

  private collection(name: string): Collection<StringIdDocument> {
    return this.db.collection<StringIdDocument>(name);
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.collection('community_sources').createIndex({ slug: 1 }, { unique: true }),
      this.collection('community_sources').createIndex({ enabled: 1, permission: 1, nextRunAt: 1 }),
      this.collection('source_runs').createIndex({ sourceId: 1, scheduledFor: 1 }, { unique: true }),
      this.collection('source_runs').createIndex({ status: 1, leaseUntil: 1 }),
      this.collection('fetch_artifacts').createIndex({ sourceId: 1, contentHash: 1 }, { unique: true }),
      this.collection('parse_runs').createIndex({ artifactId: 1, parserId: 1, parserVersion: 1 }, { unique: true }),
      this.collection('source_observations').createIndex(
        { sourceId: 1, sourceItemKey: 1, itemContentHash: 1, parserVersion: 1 },
        { unique: true },
      ),
      this.collection('ingestion_candidates').createIndex({ fingerprint: 1 }, { unique: true }),
      this.collection('ingestion_candidates').createIndex({ blockingKeys: 1 }),
      this.collection('ingestion_candidates').createIndex({ sourceId: 1, reviewStatus: 1, createdAt: -1 }),
      this.collection('ingestion_candidates').createIndex({ reviewLane: 1, reviewStatus: 1, createdAt: -1 }),
      this.collection('source_health').createIndex({ sourceId: 1 }, { unique: true }),
    ]);
  }

  async upsertSource(source: SourceDefinition, registryVersion: string): Promise<void> {
    await this.collection('community_sources').updateOne(
      { _id: source.id },
      { $set: { ...source, registryVersion, nextRunAt: new Date(source.nextRunAt), lastVerifiedAt: new Date(source.lastVerifiedAt) } },
      { upsert: true },
    );
  }

  async startRun(sourceId: string, scheduledFor: Date): Promise<string> {
    const id = randomUUID();
    await this.collection('source_runs').insertOne({
      _id: id,
      sourceId,
      scheduledFor,
      status: 'PARSING',
      startedAt: new Date(),
    });
    return id;
  }

  async finishRun(runId: string, completeness: 'COMPLETE' | 'PARTIAL', metrics: RunMetrics): Promise<void> {
    await this.collection('source_runs').updateOne(
      { _id: runId },
      { $set: { status: completeness, completeness, metrics, finishedAt: new Date() } },
    );
  }

  async failRun(runId: string, code: string): Promise<void> {
    await this.collection('source_runs').updateOne(
      { _id: runId },
      { $set: { status: 'FAILED', errorCode: code, finishedAt: new Date() } },
    );
  }

  async putArtifact(record: ArtifactRecord): Promise<{ id: string; created: boolean }> {
    const result = await this.collection('fetch_artifacts').updateOne(
      { sourceId: record.sourceId, contentHash: record.contentHash },
      { $setOnInsert: { _id: record.id, ...record } },
      { upsert: true },
    );
    if (result.upsertedCount === 1) return { id: record.id, created: true };
    const existing = await this.collection('fetch_artifacts').findOne(
      { sourceId: record.sourceId, contentHash: record.contentHash },
      { projection: { _id: 1 } },
    );
    return { id: String(existing?._id), created: false };
  }

  async parseRunCompleteness(
    artifactId: string,
    parserId: string,
    parserVersion: string,
  ): Promise<'COMPLETE' | 'PARTIAL' | null> {
    const parseRun = await this.collection('parse_runs').findOne({ artifactId, parserId, parserVersion });
    if (!parseRun) return null;
    if (parseRun.completeness === 'COMPLETE' || parseRun.completeness === 'PARTIAL') {
      return parseRun.completeness;
    }
    // Backward-compatible recovery for parse evidence written before the
    // completeness field was added: the immutable source run retains it.
    const sourceRun = typeof parseRun.runId === 'string'
      ? await this.collection('source_runs').findOne({ _id: parseRun.runId })
      : null;
    return sourceRun?.completeness === 'PARTIAL' || sourceRun?.status === 'PARTIAL'
      ? 'PARTIAL'
      : 'COMPLETE';
  }

  async recordParseRun(
    artifactId: string,
    parserId: string,
    parserVersion: string,
    runId: string,
    completeness: 'COMPLETE' | 'PARTIAL',
  ): Promise<void> {
    await this.collection('parse_runs').updateOne(
      { artifactId, parserId, parserVersion },
      {
        $setOnInsert: {
          _id: randomUUID(), artifactId, parserId, parserVersion, runId, parsedAt: new Date(),
        },
        $set: { completeness },
      },
      { upsert: true },
    );
  }

  async putObservation(record: ObservationRecord): Promise<{ id: string; created: boolean }> {
    const filter = {
      sourceId: record.sourceId,
      sourceItemKey: record.sourceItemKey,
      itemContentHash: record.itemContentHash,
      parserVersion: record.parserVersion,
    };
    const result = await this.collection('source_observations').updateOne(
      filter,
      { $setOnInsert: { _id: record.id, ...record } },
      { upsert: true },
    );
    if (result.upsertedCount === 1) return { id: record.id, created: true };
    const existing = await this.collection('source_observations').findOne(filter, { projection: { _id: 1 } });
    return { id: String(existing?._id), created: false };
  }

  async upsertCandidate(
    record: CandidateRecord,
    legacyRelationshipFingerprint?: string,
  ): Promise<{ id: string; created: boolean }> {
    let existing = await this.collection('ingestion_candidates').findOne(
      { fingerprint: record.fingerprint },
      {
        projection: {
          _id: 1, reviewStatus: 1, observationId: 1, parentSourceItemKey: 1, lastObservedAt: 1,
        },
      },
    );
    let backfillParentSourceItemKey = false;
    if (!existing && legacyRelationshipFingerprint && record.parentSourceItemKey) {
      const legacyCandidate = await this.collection('ingestion_candidates').findOne(
        {
          fingerprint: legacyRelationshipFingerprint,
        },
        {
          projection: {
            _id: 1, reviewStatus: 1, observationId: 1, parentSourceItemKey: 1, lastObservedAt: 1,
          },
        },
      );
      if (legacyCandidate) {
        let legacyParentSourceItemKey = typeof legacyCandidate.parentSourceItemKey === 'string'
          ? legacyCandidate.parentSourceItemKey
          : undefined;
        if (!legacyParentSourceItemKey && typeof legacyCandidate.observationId === 'string') {
          const legacyObservation = await this.collection('source_observations').findOne(
            { _id: legacyCandidate.observationId },
            { projection: { rawFields: 1 } },
          );
          legacyParentSourceItemKey = parentSourceItemKeyFromRawFields(legacyObservation?.rawFields);
        }
        if (legacyParentSourceItemKey === record.parentSourceItemKey) {
          existing = legacyCandidate;
          backfillParentSourceItemKey = typeof legacyCandidate.parentSourceItemKey !== 'string';
        }
      }
    }
    const laterApprovedSibling = existing?.reviewStatus === 'APPROVED'
      && existing.lastObservedAt instanceof Date
      ? await this.collection('ingestion_candidates').findOne(
        {
          sourceId: record.sourceId,
          sourceItemKey: record.sourceItemKey,
          _id: { $ne: String(existing._id) },
          reviewStatus: 'APPROVED',
          lastObservedAt: { $gt: existing.lastObservedAt },
        },
        { projection: { _id: 1 } },
      )
      : null;
    const republicationRequired = Boolean(laterApprovedSibling);
    await this.collection('ingestion_candidates').updateMany(
      {
        sourceId: record.sourceId,
        sourceItemKey: record.sourceItemKey,
        ...(existing
          ? { _id: { $ne: String(existing._id) } }
          : { fingerprint: { $ne: record.fingerprint } }),
        reviewStatus: 'PENDING',
      },
      { $set: { reviewStatus: 'SUPERSEDED', supersededAt: new Date() } },
    );
    if (existing) {
      const revive = existing.reviewStatus === 'SUPERSEDED';
      const transitionToPending = revive || republicationRequired;
      const unsetFields = {
        ...(transitionToPending
          ? republicationRequired ? republicationUnset : { supersededAt: '' }
          : {}),
      };
      await this.collection('ingestion_candidates').updateOne(
        { _id: String(existing._id) },
        {
          $set: {
            observationId: record.observationId,
            lastObservedAt: record.lastObservedAt,
            ...(record.classificationSuggestion
              ? { classificationSuggestion: record.classificationSuggestion }
              : {}),
            ...(record.recurringSeriesKey
              ? { recurringSeriesKey: record.recurringSeriesKey }
              : {}),
            ...(backfillParentSourceItemKey
              ? { parentSourceItemKey: record.parentSourceItemKey }
              : {}),
            ...(transitionToPending ? { reviewStatus: 'PENDING' } : {}),
          },
          ...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}),
        },
      );
      return { id: String(existing._id), created: false };
    }
    try {
      await this.collection('ingestion_candidates').insertOne({ _id: record.id, ...record });
      return { id: record.id, created: true };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const winner = await this.collection('ingestion_candidates').findOne(
        { fingerprint: record.fingerprint },
        { projection: { _id: 1 } },
      );
      return { id: String(winner?._id), created: false };
    }
  }

  async recordHealth(sourceId: string, status: SourceHealthStatus, errorCode?: string): Promise<void> {
    const attemptedAt = new Date();
    const failure = status !== 'COMPLETE';
    await this.collection('source_health').updateOne(
      { _id: sourceId },
      [{
        $set: {
          sourceId,
          lastAttemptAt: attemptedAt,
          lastStatus: status,
          consecutiveFailures: failure
            ? { $add: [{ $ifNull: ['$consecutiveFailures', 0] }, 1] }
            : 0,
          ...(status === 'COMPLETE' ? { lastSuccessAt: attemptedAt } : {}),
          ...(errorCode ? { lastErrorCode: errorCode } : { lastErrorCode: '$$REMOVE' }),
        },
      }],
      { upsert: true },
    );
  }
}
