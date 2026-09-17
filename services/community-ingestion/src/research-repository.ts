import type { Collection, Db, Document, MongoClient } from 'mongodb';
import type {
  CandidateForResearch,
  CandidateResearchBasis,
  CandidateResearchRecord,
} from './research.js';
import { CURATOR_LOCATION_CONFIRMED_FIELD } from './research.js';

type StringIdDocument = Document & { _id: string };

export type RetainedResearchArtifact = {
  id: string;
  contentHash: string;
  mediaType: string;
  sourceUrl: string;
  statusCode: number;
  responseHeaders: Record<string, string>;
};

export type CandidateResearchContext = {
  candidate: CandidateForResearch;
  retainedObservation: {
    id: string;
    canonicalSourceUrl: string;
    itemContentHash: string;
    rawFields: Record<string, unknown>;
  };
  retainedArtifact?: RetainedResearchArtifact;
};

export class CandidateResearchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CandidateResearchError';
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const editorialRevision = (value: unknown): number => (
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0
);

export const researchEffectiveNormalizedFields = (
  normalizedFields: unknown,
  editorialOverrides: unknown,
): Record<string, unknown> => {
  const fields = { ...asRecord(normalizedFields) };
  const overrides = asRecord(editorialOverrides);
  if (typeof overrides.title === 'string' && overrides.title.trim()) fields.title = overrides.title;
  if (typeof overrides.location === 'string' && overrides.location.trim()) {
    fields.location = overrides.location;
    fields.locationLabels = [overrides.location];
    fields[CURATOR_LOCATION_CONFIRMED_FIELD] = true;
  }
  const schedule = asRecord(overrides.schedule);
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

export class MongoCandidateResearchRepository {
  private readonly db: Db;

  constructor(client: MongoClient, databaseName?: string) {
    this.db = client.db(databaseName);
  }

  private collection(name: string): Collection<StringIdDocument> {
    return this.db.collection<StringIdDocument>(name);
  }

  async loadContext(candidateId: string): Promise<CandidateResearchContext> {
    const candidate = await this.collection('ingestion_candidates').findOne(
      { _id: candidateId },
      {
        projection: {
          _id: 1,
          sourceId: 1,
          sourceItemKey: 1,
          fingerprint: 1,
          observationId: 1,
          editorialRevision: 1,
          entityHint: 1,
          normalizedFields: 1,
          editorialOverrides: 1,
          reviewLane: 1,
          privacyReviewRequired: 1,
        },
      },
    );
    if (!candidate) throw new CandidateResearchError('CANDIDATE_NOT_FOUND', 'Candidate was not found');
    if (candidate.entityHint !== 'event' && candidate.entityHint !== 'group') {
      throw new CandidateResearchError('CANDIDATE_KIND_UNSUPPORTED', 'Candidate kind is not researchable');
    }
    if (typeof candidate.sourceId !== 'string'
      || typeof candidate.sourceItemKey !== 'string'
      || typeof candidate.fingerprint !== 'string'
      || typeof candidate.observationId !== 'string') {
      throw new CandidateResearchError('CANDIDATE_CONTEXT_INVALID', 'Candidate research context is incomplete');
    }
    const observation = await this.collection('source_observations').findOne(
      { _id: candidate.observationId },
      {
        projection: {
          _id: 1,
          artifactId: 1,
          canonicalSourceUrl: 1,
          itemContentHash: 1,
          rawFields: 1,
        },
      },
    );
    if (!observation) {
      throw new CandidateResearchError('OBSERVATION_NOT_FOUND', 'Candidate observation was not found');
    }
    if (typeof observation.canonicalSourceUrl !== 'string'
      || typeof observation.itemContentHash !== 'string') {
      throw new CandidateResearchError('OBSERVATION_CONTEXT_INVALID', 'Candidate observation is incomplete');
    }
    const normalizedFields = researchEffectiveNormalizedFields(
      candidate.normalizedFields,
      candidate.editorialOverrides,
    );
    const detailUrl = typeof normalizedFields.sourceUrl === 'string'
      ? normalizedFields.sourceUrl
      : typeof observation.canonicalSourceUrl === 'string'
        ? observation.canonicalSourceUrl
        : undefined;
    const context: CandidateResearchContext = {
      candidate: {
        id: String(candidate._id),
        sourceId: candidate.sourceId,
        sourceItemKey: candidate.sourceItemKey,
        fingerprint: candidate.fingerprint,
        observationId: candidate.observationId,
        editorialRevision: editorialRevision(candidate.editorialRevision),
        entityHint: candidate.entityHint,
        normalizedFields,
        ...(candidate.reviewLane === 'SENSITIVE' ? { reviewLane: 'SENSITIVE' as const } : {}),
        ...(candidate.privacyReviewRequired === true ? { privacyReviewRequired: true } : {}),
        ...(detailUrl ? { detailUrl } : {}),
      },
      retainedObservation: {
        id: String(observation._id),
        canonicalSourceUrl: observation.canonicalSourceUrl,
        itemContentHash: observation.itemContentHash,
        rawFields: asRecord(observation.rawFields),
      },
    };
    if (typeof observation.artifactId !== 'string') return context;
    const artifact = await this.collection('fetch_artifacts').findOne(
      { _id: observation.artifactId },
      {
        projection: {
          _id: 1,
          contentHash: 1,
          mediaType: 1,
          sourceUrl: 1,
          statusCode: 1,
          responseHeaders: 1,
        },
      },
    );
    if (artifact
      && typeof artifact.contentHash === 'string'
      && typeof artifact.mediaType === 'string'
      && typeof artifact.sourceUrl === 'string'
      && typeof artifact.statusCode === 'number') {
      context.retainedArtifact = {
        id: String(artifact._id),
        contentHash: artifact.contentHash,
        mediaType: artifact.mediaType,
        sourceUrl: artifact.sourceUrl,
        statusCode: artifact.statusCode,
        responseHeaders: Object.fromEntries(Object.entries(asRecord(artifact.responseHeaders))
          .flatMap(([name, value]) => typeof value === 'string' ? [[name, value]] : [])),
      };
    }
    return context;
  }

  private basisSelector(candidateId: string, requestId: string, basis: CandidateResearchBasis): Document {
    return {
      _id: candidateId,
      fingerprint: basis.candidateFingerprint,
      observationId: basis.observationId,
      $and: [
        {
          $or: basis.editorialRevision === 0
            ? [{ editorialRevision: 0 }, { editorialRevision: { $exists: false } }]
            : [{ editorialRevision: basis.editorialRevision }],
        },
        { 'research.requestId': requestId },
        { 'research.basis.basisKey': basis.basisKey },
      ],
    };
  }

  async markRunning(
    candidateId: string,
    requestId: string,
    basis: CandidateResearchBasis,
    at: Date,
    queue: {
      attemptCount: number;
      maxAttempts: number;
      leaseUntil: Date;
    },
  ): Promise<void> {
    const result = await this.collection('ingestion_candidates').updateOne(
      this.basisSelector(candidateId, requestId, basis),
      {
        $set: {
          'research.status': 'RUNNING',
          'research.startedAt': at,
          'research.updatedAt': at,
          'research.queue.status': 'RUNNING',
          'research.queue.attemptCount': queue.attemptCount,
          'research.queue.maxAttempts': queue.maxAttempts,
          'research.queue.lastAttemptAt': at,
          'research.queue.leaseUntil': queue.leaseUntil,
          'research.queue.progressStage': 'STARTING',
          'research.queue.progressMessage': queue.attemptCount > 1
            ? 'Recovered this candidate after an earlier worker lease expired.'
            : 'An ingestion worker claimed this candidate.',
          'research.queue.updatedAt': at,
        },
        $unset: {
          'research.finishedAt': '',
          'research.errorCode': '',
          'research.queue.availableAt': '',
          'research.queue.nextAttemptAt': '',
        },
      },
    );
    if (result.modifiedCount !== 1) {
      throw new CandidateResearchError('RESEARCH_BASIS_STALE', 'Candidate changed before research started');
    }
  }

  async progress(
    candidateId: string,
    requestId: string,
    basis: CandidateResearchBasis,
    progress: { stage: string; message: string; updatedAt: Date },
  ): Promise<void> {
    const result = await this.collection('ingestion_candidates').updateOne(
      this.basisSelector(candidateId, requestId, basis),
      {
        $set: {
          'research.queue.progressStage': progress.stage,
          'research.queue.progressMessage': progress.message,
          'research.queue.updatedAt': progress.updatedAt,
          'research.updatedAt': progress.updatedAt,
        },
      },
    );
    if (result.matchedCount !== 1) {
      throw new CandidateResearchError('RESEARCH_BASIS_STALE', 'Candidate changed while research was running');
    }
  }

  async complete(
    candidateId: string,
    requestId: string,
    basis: CandidateResearchBasis,
    research: CandidateResearchRecord,
  ): Promise<void> {
    const result = await this.collection('ingestion_candidates').updateOne(
      this.basisSelector(candidateId, requestId, basis),
      { $set: { research } },
    );
    if (result.modifiedCount !== 1) {
      throw new CandidateResearchError('RESEARCH_BASIS_STALE', 'Candidate changed before research completed');
    }
  }

  async fail(
    candidateId: string,
    requestId: string,
    basis: CandidateResearchBasis,
    code: string,
    at: Date,
    queue?: { attemptCount: number; maxAttempts: number },
  ): Promise<void> {
    await this.collection('ingestion_candidates').updateOne(
      this.basisSelector(candidateId, requestId, basis),
      {
        $set: {
          'research.status': 'FAILED',
          'research.errorCode': code,
          'research.retryable': true,
          'research.finishedAt': at,
          'research.updatedAt': at,
          'research.queue.status': 'FAILED',
          'research.queue.attemptCount': queue?.attemptCount ?? 1,
          'research.queue.maxAttempts': queue?.maxAttempts ?? 1,
          'research.queue.lastErrorCode': code,
          'research.queue.lastErrorAt': at,
          'research.queue.progressStage': 'FAILED',
          'research.queue.progressMessage': 'Research stopped after the retry limit. It can be retried manually.',
          'research.queue.updatedAt': at,
        },
        $unset: {
          'research.queue.leaseUntil': '',
          'research.queue.availableAt': '',
          'research.queue.nextAttemptAt': '',
        },
      },
    );
  }

  async retry(
    candidateId: string,
    requestId: string,
    basis: CandidateResearchBasis,
    code: string,
    at: Date,
    nextAttemptAt: Date,
    queue: { attemptCount: number; maxAttempts: number },
  ): Promise<void> {
    const result = await this.collection('ingestion_candidates').updateOne(
      this.basisSelector(candidateId, requestId, basis),
      {
        $set: {
          'research.status': 'QUEUED',
          'research.retryable': true,
          'research.errorCode': code,
          'research.updatedAt': at,
          'research.queue.status': 'QUEUED',
          'research.queue.attemptCount': queue.attemptCount,
          'research.queue.maxAttempts': queue.maxAttempts,
          'research.queue.availableAt': nextAttemptAt,
          'research.queue.nextAttemptAt': nextAttemptAt,
          'research.queue.lastErrorCode': code,
          'research.queue.lastErrorAt': at,
          'research.queue.progressStage': 'RETRY_BACKOFF',
          'research.queue.progressMessage': 'A temporary worker error occurred. This candidate will retry automatically.',
          'research.queue.updatedAt': at,
        },
        $unset: {
          'research.finishedAt': '',
          'research.queue.leaseUntil': '',
        },
      },
    );
    if (result.matchedCount !== 1) {
      throw new CandidateResearchError('RESEARCH_BASIS_STALE', 'Candidate changed before research could retry');
    }
  }
}
