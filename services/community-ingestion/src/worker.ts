import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  MongoClient, type Collection, type Document, type WithId,
} from 'mongodb';
import { LiveSourceAdapter } from './adapters/live-source.js';
import { ManualSupportAdapter } from './adapters/manual-support.js';
import type { FetchArtifactInput, SourceAdapter, SourceDefinition } from './contracts.js';
import { FileArtifactStore } from './artifact-store.js';
import { sha256 } from './hash.js';
import {
  candidateResearchBasisFor,
  researchSearchProviderFromEnvironment,
  runCandidateResearch,
} from './research.js';
import {
  MongoCandidateResearchRepository,
  type CandidateResearchContext,
} from './research-repository.js';
import { MongoIngestionRepository } from './repository.js';
import { executeSource, fetchSourceArtifact } from './source-execution.js';
import { loadSourceRegistry } from './source-registry.js';
import { SafeHttpClient, type SafeHttpResult } from './safe-http-client.js';

export type RunRequest = {
  _id: string;
  sourceId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED_RECENT' | 'ALREADY_RUNNING';
  executionMode: 'PRACTICE' | 'MANUAL' | 'RESEARCH';
  candidateId?: string;
  candidateFingerprint?: string;
  candidateObservationId?: string;
  candidateEditorialRevision?: number;
  researchBasisKey?: string;
  activeGuard?: 'ACTIVE';
  candidateActiveGuard?: 'ACTIVE';
  availableAt: Date;
  requestedAt: Date;
  attempts?: number;
  maxAttempts?: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseUntil?: Date;
  errorCode?: string;
};

export const RESEARCH_QUEUE_MAX_ATTEMPTS = 3;
export const REQUEST_LEASE_MS = 2 * 60 * 1000;
const REQUEST_HEARTBEAT_MS = 15 * 1000;
export const WORKER_HEALTH_LEASE_MS = 20 * 1000;
const WORKER_HEARTBEAT_MS = 5 * 1000;
const CLAIM_SCAN_LIMIT = 500;
const WORKER_HEALTH_CONTRACT_VERSION = 'ingestion-worker-health.v1';
const DEFAULT_USER_AGENT = 'MatchBookCommunityRegister/0.2 (+https://christianjoudon.github.io/work/matchbook.html)';
const DEFAULT_COMMUNITY_ARTIFACT_ROOT = fileURLToPath(new URL('../.artifacts/community', import.meta.url));
const DEFAULT_SUPPORT_ARTIFACT_ROOT = fileURLToPath(new URL('../.artifacts/support', import.meta.url));

export const governedArtifactRootsFor = (sourceId: string, configuredRoot?: string): string[] => {
  const defaults = sourceId.startsWith('SEN-')
    ? [DEFAULT_SUPPORT_ARTIFACT_ROOT, DEFAULT_COMMUNITY_ARTIFACT_ROOT]
    : [DEFAULT_COMMUNITY_ARTIFACT_ROOT, DEFAULT_SUPPORT_ARTIFACT_ROOT];
  return [...new Set([...(configuredRoot ? [configuredRoot] : []), ...defaults])];
};

const errorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 120);
  }
  return 'INGESTION_FAILED';
};

const duplicateKey = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  return code === 11000 || String((error as { message?: unknown }).message || '').includes('E11000');
};

const retryAfterFrom = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object' || !('retryAfterMs' in error)) return undefined;
  const delay = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof delay === 'number' && Number.isFinite(delay) && delay >= 0
    ? Math.min(delay, 24 * 60 * 60 * 1000)
    : undefined;
};

const NON_RETRYABLE_WORKER_CODES = new Set([
  'BODY_TOO_LARGE',
  'CANDIDATE_CONTEXT_INVALID',
  'CANDIDATE_KIND_UNSUPPORTED',
  'CANDIDATE_NOT_FOUND',
  'DNS_IP_BLOCKED',
  'EXECUTION_MODE_MISMATCH',
  'HOST_NOT_ALLOWED',
  'HTTP_REJECTED',
  'INVALID_URL',
  'MIME_REJECTED',
  'OBSERVATION_CONTEXT_INVALID',
  'OBSERVATION_NOT_FOUND',
  'REDIRECT_INVALID',
  'REDIRECT_LIMIT',
  'RESEARCH_BASIS_STALE',
  'RESEARCH_CANDIDATE_REQUIRED',
  'RETAINED_ARTIFACT_HASH_MISMATCH',
  'SOURCE_NOT_FOUND',
]);

export const retryableWorkerError = (code: string): boolean => (
  !NON_RETRYABLE_WORKER_CODES.has(code)
);

export const researchRetryDelayMs = (attempt: number, requestedDelay?: number): number => {
  if (requestedDelay !== undefined) return Math.max(1_000, requestedDelay);
  return Math.min(5_000 * (2 ** Math.max(0, attempt - 1)), 5 * 60 * 1000);
};

const claimGuardedRequest = async (
  collection: Collection<RunRequest>,
  workerId: string,
): Promise<WithId<RunRequest> | null> => {
  const now = new Date();
  const token = randomUUID();
  return collection.findOneAndUpdate(
    {
      activeGuard: 'ACTIVE',
      $or: [
        { status: 'QUEUED', availableAt: { $lte: now } },
        { status: 'RUNNING', leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'RUNNING',
        leaseOwner: workerId,
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + REQUEST_LEASE_MS),
        startedAt: now,
        lastAttemptAt: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { requestedAt: 1, _id: 1 }, returnDocument: 'after' },
  );
};

const claimWaitingResearch = async (
  collection: Collection<RunRequest>,
  workerId: string,
): Promise<WithId<RunRequest> | null> => {
  const now = new Date();
  const waiters = await collection.find({
    executionMode: 'RESEARCH',
    status: 'QUEUED',
    activeGuard: { $exists: false },
    availableAt: { $lte: now },
  }).sort({ requestedAt: 1, _id: 1 }).limit(CLAIM_SCAN_LIMIT).toArray();
  for (const waiter of waiters) {
    const token = randomUUID();
    try {
      const claimed = await collection.findOneAndUpdate(
        {
          _id: waiter._id,
          executionMode: 'RESEARCH',
          status: 'QUEUED',
          activeGuard: { $exists: false },
          availableAt: { $lte: now },
        },
        {
          $set: {
            status: 'RUNNING',
            activeGuard: 'ACTIVE',
            leaseOwner: workerId,
            leaseToken: token,
            leaseUntil: new Date(now.getTime() + REQUEST_LEASE_MS),
            startedAt: now,
            lastAttemptAt: now,
          },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' },
      );
      if (claimed) return claimed;
    } catch (error) {
      // The source-wide partial unique index is the serialization authority.
      // A different active source job means this candidate remains QUEUED; it
      // is never converted into a terminal/discarded decision.
      if (!duplicateKey(error)) throw error;
    }
  }
  return null;
};

/**
 * Claims ordinary guarded runs first, then promotes the oldest candidate
 * research waiter whose source is free. Expired RUNNING leases are reclaimable
 * through the first branch, making host/worker restarts self-healing.
 */
export const claimNextRequest = async (
  collection: Collection<RunRequest>,
  workerId: string,
): Promise<WithId<RunRequest> | null> => (
  await claimGuardedRequest(collection, workerId)
  ?? claimWaitingResearch(collection, workerId)
);

const adapterForResearch = (source: SourceDefinition): SourceAdapter => (
  source.adapterKind === 'MANUAL_CLIP'
    ? new ManualSupportAdapter()
    : new LiveSourceAdapter(source.adapterKind)
);

const extractArtifact = async (
  artifact: FetchArtifactInput,
  source: SourceDefinition,
) => {
  const result = await adapterForResearch(source).extract(artifact, source);
  return {
    items: result.items,
    evidenceUrl: artifact.sourceUrl,
    contentHash: sha256(artifact.bytes),
  };
};

const extractOfficialDetail = async (
  response: SafeHttpResult,
  requestedUrl: string,
  source: SourceDefinition,
) => {
  const adapter = response.mediaType === 'text/html'
    ? new LiveSourceAdapter('JSON_LD_HTML')
    : adapterForResearch(source);
  const result = await adapter.extract(response, source);
  return {
    items: result.items,
    // Evidence is tied to the governed URL that was requested. SafeHttpClient
    // may follow a registered redirect, but redirect targets are not published.
    evidenceUrl: requestedUrl,
    contentHash: sha256(response.bytes),
  };
};

const retainedArtifactInput = async (
  context: CandidateResearchContext,
  artifactRoots: string[],
): Promise<FetchArtifactInput> => {
  const retained = context.retainedArtifact;
  if (!retained) {
    throw Object.assign(new Error('Retained artifact is unavailable'), { code: 'RETAINED_ARTIFACT_UNAVAILABLE' });
  }
  let mismatch = false;
  for (const artifactRoot of [...new Set(artifactRoots)]) {
    try {
      const bytes = await new FileArtifactStore(artifactRoot).read(retained.contentHash);
      if (sha256(bytes) !== retained.contentHash) {
        mismatch = true;
        continue;
      }
      return {
        bytes,
        mediaType: retained.mediaType,
        sourceUrl: retained.sourceUrl,
        statusCode: retained.statusCode,
        responseHeaders: retained.responseHeaders,
      };
    } catch {
      // The artifact store is content addressed. Missing bytes at one governed
      // root are allowed because public and sensitive snapshots intentionally
      // use separate roots; no arbitrary filesystem search is performed.
    }
  }
  throw Object.assign(
    new Error(mismatch
      ? 'Retained artifact hash does not reconcile'
      : 'Retained artifact cannot be read from a governed artifact store'),
    { code: mismatch ? 'RETAINED_ARTIFACT_HASH_MISMATCH' : 'RETAINED_ARTIFACT_UNAVAILABLE' },
  );
};

const rawText = (value: unknown): string | undefined => {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = `${value}`.trim();
    return text || undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return rawText(record.rendered ?? record.name ?? record.value);
};

const rawLocation = (value: unknown): string | undefined => {
  const direct = rawText(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const address = record.address && typeof record.address === 'object' && !Array.isArray(record.address)
    ? record.address as Record<string, unknown>
    : record;
  const text = [
    rawText(record.name ?? record.venue),
    rawText(address.streetAddress ?? address.address),
    rawText(address.addressLocality ?? address.city),
    rawText(address.addressRegion ?? address.state),
    rawText(address.postalCode ?? address.zip),
  ].filter(Boolean).join(', ');
  return text || undefined;
};

const retainedObservationExtraction = (context: CandidateResearchContext) => {
  const raw = context.retainedObservation.rawFields;
  const normalizedFields = {
    ...context.candidate.normalizedFields,
    ...(rawText(raw.title ?? raw.name ?? raw.SUMMARY)
      ? { title: rawText(raw.title ?? raw.name ?? raw.SUMMARY) }
      : {}),
    ...(rawText(raw.description ?? raw.DESCRIPTION ?? raw.note)
      ? { description: rawText(raw.description ?? raw.DESCRIPTION ?? raw.note) }
      : {}),
    ...(rawLocation(raw.location ?? raw.LOCATION ?? raw.venue ?? raw.where)
      ? { location: rawLocation(raw.location ?? raw.LOCATION ?? raw.venue ?? raw.where) }
      : {}),
    ...(rawText(raw.start_date ?? raw.startDate ?? raw.DTSTART)
      ? { localStart: rawText(raw.start_date ?? raw.startDate ?? raw.DTSTART) }
      : {}),
    ...(rawText(raw.end_date ?? raw.endDate ?? raw.DTEND)
      ? { localEnd: rawText(raw.end_date ?? raw.endDate ?? raw.DTEND) }
      : {}),
    ...(rawText(raw.timezone ?? raw.timeZone)
      ? { timeZone: rawText(raw.timezone ?? raw.timeZone) }
      : {}),
    ...(rawText(raw.eventAttendanceMode ?? raw.attendanceMode)
      ? { attendanceMode: rawText(raw.eventAttendanceMode ?? raw.attendanceMode) }
      : {}),
    ...(rawText(raw.recurrenceLabel ?? raw.recurrence ?? raw.RRULE)
      ? { recurrenceLabel: rawText(raw.recurrenceLabel ?? raw.recurrence ?? raw.RRULE) }
      : {}),
  };
  return {
    items: [{
      sourceItemKey: context.candidate.sourceItemKey,
      canonicalSourceUrl: context.retainedObservation.canonicalSourceUrl,
      entityHint: context.candidate.entityHint,
      rawFields: {},
      normalizedFields,
      evidence: [],
    }],
    evidenceUrl: context.retainedObservation.canonicalSourceUrl,
    contentHash: context.retainedObservation.itemContentHash,
  };
};

const retainedExtraction = async (
  context: CandidateResearchContext,
  source: SourceDefinition,
  artifactRoots: string[],
) => {
  if (!context.retainedArtifact) return retainedObservationExtraction(context);
  return extractArtifact(await retainedArtifactInput(context, artifactRoots), source);
};

const processResearch = async (options: {
  request: WithId<RunRequest>;
  client: MongoClient;
  source: SourceDefinition;
  artifactRoot?: string;
  userAgent?: string;
}): Promise<{
  repository: MongoCandidateResearchRepository;
  context: CandidateResearchContext;
  basis: ReturnType<typeof candidateResearchBasisFor>;
  status: string;
  suggestionCount: number;
  evidenceCount: number;
}> => {
  const candidateId = options.request.candidateId;
  if (!candidateId) {
    throw Object.assign(new Error('Research request omitted candidateId'), { code: 'RESEARCH_CANDIDATE_REQUIRED' });
  }
  const repository = new MongoCandidateResearchRepository(options.client);
  const context = await repository.loadContext(candidateId);
  const basis = candidateResearchBasisFor(context.candidate);
  if (context.candidate.sourceId !== options.source.id
    || options.request.candidateFingerprint !== basis.candidateFingerprint
    || options.request.candidateObservationId !== basis.observationId
    || options.request.candidateEditorialRevision !== basis.editorialRevision
    || options.request.researchBasisKey !== basis.basisKey) {
    throw Object.assign(new Error('Research request no longer matches its candidate'), { code: 'RESEARCH_BASIS_STALE' });
  }
  const now = new Date();
  const attemptCount = options.request.attempts ?? 1;
  const maxAttempts = options.request.maxAttempts ?? RESEARCH_QUEUE_MAX_ATTEMPTS;
  await repository.markRunning(candidateId, options.request._id, basis, now, {
    attemptCount,
    maxAttempts,
    leaseUntil: options.request.leaseUntil ?? new Date(now.getTime() + REQUEST_LEASE_MS),
  });
  const http = new SafeHttpClient({ userAgent: options.userAgent ?? DEFAULT_USER_AGENT });
  const searchProvider = researchSearchProviderFromEnvironment();
  const artifactRoots = governedArtifactRootsFor(options.source.id, options.artifactRoot);
  const research = await runCandidateResearch({
    requestId: options.request._id,
    candidate: context.candidate,
    source: options.source,
    retainedEvidence: async () => retainedExtraction(
      context,
      options.source,
      artifactRoots,
    ),
    officialDetail: async requestedUrl => extractOfficialDetail(
      await http.fetch({ method: 'GET', url: requestedUrl }, options.source.httpPolicy),
      requestedUrl,
      options.source,
    ),
    registeredSourceRefetch: async () => extractArtifact(
      await fetchSourceArtifact(options.source, http),
      options.source,
    ),
    onProgress: progress => repository.progress(
      candidateId,
      options.request._id,
      basis,
      {
        stage: progress.stage,
        message: progress.message,
        updatedAt: progress.updatedAt,
      },
    ),
    ...(searchProvider ? { searchProvider } : {}),
  });
  const completedResearch = {
    ...research,
    queue: {
      status: research.status,
      attemptCount,
      maxAttempts,
      lastAttemptAt: now,
      ...(research.errorCode ? {
        lastErrorCode: research.errorCode,
        lastErrorAt: research.finishedAt,
      } : {}),
      progressStage: 'COMPLETE',
      progressMessage: research.missingFields.length
        ? 'Research finished. Review the evidence, suggestions, and unresolved fields.'
        : 'Research finished with suggestions for every missing field.',
      updatedAt: research.updatedAt,
    },
  };
  await repository.complete(candidateId, options.request._id, basis, completedResearch);
  return {
    repository,
    context,
    basis,
    status: completedResearch.status,
    suggestionCount: completedResearch.fieldSuggestions.length,
    evidenceCount: completedResearch.evidence.length,
  };
};

export const processRequest = async (options: {
  request: WithId<RunRequest>;
  requests: Collection<RunRequest>;
  client: MongoClient;
  workerId: string;
  artifactRoot?: string;
  userAgent?: string;
}): Promise<void> => {
  const { request, requests, client, workerId } = options;
  const token = request.leaseToken;
  if (!token) throw new Error('Claimed request omitted its lease token');
  const heartbeat = setInterval(() => {
    const at = new Date();
    const leaseUntil = new Date(at.getTime() + REQUEST_LEASE_MS);
    void requests.updateOne(
      { _id: request._id, status: 'RUNNING', leaseOwner: workerId, leaseToken: token },
      { $set: { leaseUntil, heartbeatAt: at } },
    ).then(async result => {
      if (!result.matchedCount || request.executionMode !== 'RESEARCH' || !request.candidateId) return;
      await client.db().collection<Document & { _id: string }>('ingestion_candidates').updateOne(
        { _id: request.candidateId, 'research.requestId': request._id },
        {
          $set: {
            'research.queue.leaseUntil': leaseUntil,
            'research.queue.updatedAt': at,
          },
        },
      );
    }).catch(() => {});
  }, REQUEST_HEARTBEAT_MS);
  heartbeat.unref();
  let researchState: Awaited<ReturnType<typeof processResearch>> | undefined;
  try {
    const registry = await loadSourceRegistry();
    const source = registry.sources.find(candidate => candidate.id === request.sourceId);
    if (!source) throw Object.assign(new Error('Run request names an unknown governed source'), { code: 'SOURCE_NOT_FOUND' });
    if (request.executionMode === 'RESEARCH') {
      researchState = await processResearch({
        request,
        client,
        source,
        ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      });
      await requests.updateOne(
        { _id: request._id, status: 'RUNNING', leaseOwner: workerId, leaseToken: token },
        {
          $set: {
            status: 'SUCCEEDED',
            resultKind: 'CANDIDATE_RESEARCH',
            resultCandidateId: researchState.context.candidate.id,
            resultObservationId: researchState.basis.observationId,
            resultBasisKey: researchState.basis.basisKey,
            researchStatus: researchState.status,
            suggestionCount: researchState.suggestionCount,
            evidenceCount: researchState.evidenceCount,
            finishedAt: new Date(),
          },
          $unset: {
            activeGuard: '', candidateActiveGuard: '', leaseOwner: '', leaseToken: '', leaseUntil: '',
          },
        },
      );
      return;
    }
    if (request.executionMode === 'MANUAL' && source.adapterKind !== 'MANUAL_CLIP') {
      throw Object.assign(new Error('Manual request does not match its source adapter'), { code: 'EXECUTION_MODE_MISMATCH' });
    }
    if (request.executionMode === 'PRACTICE' && source.permission !== 'PROBE_REQUIRED') {
      throw Object.assign(new Error('Practice request does not match its source permission'), { code: 'EXECUTION_MODE_MISMATCH' });
    }
    const repository = new MongoIngestionRepository(client);
    const result = await executeSource({
      source,
      registry,
      repository,
      ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    });
    await requests.updateOne(
      { _id: request._id, status: 'RUNNING', leaseOwner: workerId, leaseToken: token },
      {
        $set: {
          status: 'SUCCEEDED',
          resultRunId: result.runId,
          completeness: result.completeness,
          metrics: result.metrics,
          finishedAt: new Date(),
        },
        $unset: { activeGuard: '', leaseOwner: '', leaseToken: '', leaseUntil: '' },
      },
    );
  } catch (error) {
    const code = errorCode(error);
    const attemptCount = request.attempts ?? 1;
    const maxAttempts = request.maxAttempts ?? RESEARCH_QUEUE_MAX_ATTEMPTS;
    const shouldRetry = request.executionMode === 'RESEARCH'
      && attemptCount < maxAttempts
      && retryableWorkerError(code);
    const failedAt = new Date();
    const nextAttemptAt = shouldRetry
      ? new Date(failedAt.getTime() + researchRetryDelayMs(attemptCount, retryAfterFrom(error)))
      : undefined;
    if (request.executionMode === 'RESEARCH'
      && request.candidateId
      && request.candidateFingerprint
      && request.candidateObservationId
      && request.candidateEditorialRevision !== undefined
      && request.researchBasisKey) {
      const repository = researchState?.repository ?? new MongoCandidateResearchRepository(client);
      const basis = {
        candidateFingerprint: request.candidateFingerprint,
        observationId: request.candidateObservationId,
        editorialRevision: request.candidateEditorialRevision,
        basisKey: request.researchBasisKey,
      };
      if (shouldRetry && nextAttemptAt) {
        await repository.retry(
          request.candidateId,
          request._id,
          basis,
          code,
          failedAt,
          nextAttemptAt,
          { attemptCount, maxAttempts },
        ).catch(() => {});
      } else {
        await repository.fail(
          request.candidateId,
          request._id,
          basis,
          code,
          failedAt,
          { attemptCount, maxAttempts },
        ).catch(() => {});
      }
    }
    if (shouldRetry && nextAttemptAt) {
      await requests.updateOne(
        { _id: request._id, status: 'RUNNING', leaseOwner: workerId, leaseToken: token },
        {
          $set: {
            status: 'QUEUED',
            availableAt: nextAttemptAt,
            nextAttemptAt,
            errorCode: code,
            lastErrorAt: failedAt,
          },
          $unset: {
            activeGuard: '', leaseOwner: '', leaseToken: '', leaseUntil: '', finishedAt: '',
          },
        },
      );
    } else {
      await requests.updateOne(
        { _id: request._id, status: 'RUNNING', leaseOwner: workerId, leaseToken: token },
        {
          $set: { status: 'FAILED', errorCode: code, finishedAt: failedAt, lastErrorAt: failedAt },
          $unset: {
            activeGuard: '', candidateActiveGuard: '', leaseOwner: '', leaseToken: '', leaseUntil: '',
          },
        },
      );
    }
  } finally {
    clearInterval(heartbeat);
  }
};

export const runWorker = async (options: {
  mongoUrl: string;
  once?: boolean;
  pollMs?: number;
  artifactRoot?: string;
  userAgent?: string;
  signal?: AbortSignal;
}): Promise<{ processed: number }> => {
  const client = new MongoClient(options.mongoUrl);
  await client.connect();
  let processed = 0;
  const workerId = `worker:${randomUUID()}`;
  const health = client.db().collection<Document & { _id: string }>('ingestion_worker_health');
  const startedAt = new Date();
  const writeHeartbeat = async (extra: Record<string, unknown> = {}) => {
    const heartbeatAt = new Date();
    await health.updateOne(
      { _id: workerId },
      {
        $set: {
          contractVersion: WORKER_HEALTH_CONTRACT_VERSION,
          status: 'ONLINE',
          heartbeatAt,
          leaseUntil: new Date(heartbeatAt.getTime() + WORKER_HEALTH_LEASE_MS),
          processed,
          ...extra,
        },
        $setOnInsert: { startedAt },
      },
      { upsert: true },
    );
  };
  await health.updateOne(
    { _id: workerId },
    {
      $set: {
        contractVersion: WORKER_HEALTH_CONTRACT_VERSION,
        status: 'STARTING',
        startedAt,
        heartbeatAt: startedAt,
        leaseUntil: new Date(startedAt.getTime() + WORKER_HEALTH_LEASE_MS),
        processed,
      },
    },
    { upsert: true },
  );
  let healthHeartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const requests = client.db().collection<RunRequest>('ingestion_run_requests');
    await Promise.all([
      requests.createIndex(
        { status: 1, availableAt: 1, requestedAt: 1 },
      ),
      requests.createIndex(
        { sourceId: 1, activeGuard: 1 },
        {
          unique: true,
          name: 'ingestion_run_requests_one_active_source',
          partialFilterExpression: { activeGuard: 'ACTIVE' },
        },
      ),
      requests.createIndex(
        { candidateId: 1, researchBasisKey: 1, candidateActiveGuard: 1 },
        {
          unique: true,
          name: 'ingestion_run_requests_one_active_candidate_research',
          partialFilterExpression: { candidateActiveGuard: 'ACTIVE' },
        },
      ),
      health.createIndex(
        { leaseUntil: 1 },
        { name: 'ingestion_worker_health_lease' },
      ),
    ]);
    await writeHeartbeat();
    healthHeartbeat = setInterval(() => {
      void writeHeartbeat().catch(() => {});
    }, WORKER_HEARTBEAT_MS);
    healthHeartbeat.unref();
    while (!options.signal?.aborted) {
      const request = await claimNextRequest(requests, workerId);
      if (!request) {
        if (options.once) break;
        await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1_000));
        continue;
      }
      await writeHeartbeat({
        currentRequestId: request._id,
        currentSourceId: request.sourceId,
        currentExecutionMode: request.executionMode,
        ...(request.candidateId ? { currentCandidateId: request.candidateId } : {}),
      });
      await processRequest({
        request,
        requests,
        client,
        workerId,
        ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      });
      processed += 1;
      const completedAt = new Date();
      const completed = await requests.findOne(
        { _id: request._id },
        { projection: { errorCode: 1 } },
      );
      await health.updateOne(
        { _id: workerId },
        {
          $set: {
            status: 'ONLINE',
            heartbeatAt: completedAt,
            leaseUntil: new Date(completedAt.getTime() + WORKER_HEALTH_LEASE_MS),
            processed,
            lastCompletedAt: completedAt,
            ...(typeof completed?.errorCode === 'string'
              ? { lastErrorCode: completed.errorCode }
              : {}),
          },
          $unset: {
            currentRequestId: '',
            currentSourceId: '',
            currentCandidateId: '',
            currentExecutionMode: '',
            ...(typeof completed?.errorCode === 'string' ? {} : { lastErrorCode: '' }),
          },
        },
      );
      if (options.once) break;
    }
    return { processed };
  } catch (error) {
    const stoppedAt = new Date();
    await health.updateOne(
      { _id: workerId },
      {
        $set: {
          status: 'OFFLINE',
          heartbeatAt: stoppedAt,
          leaseUntil: stoppedAt,
          stoppedAt,
          lastErrorCode: errorCode(error),
          processed,
        },
        $unset: {
          currentRequestId: '',
          currentSourceId: '',
          currentCandidateId: '',
          currentExecutionMode: '',
        },
      },
    ).catch(() => {});
    throw error;
  } finally {
    if (healthHeartbeat) clearInterval(healthHeartbeat);
    const stoppedAt = new Date();
    await health.updateOne(
      { _id: workerId },
      {
        $set: {
          status: 'OFFLINE',
          heartbeatAt: stoppedAt,
          leaseUntil: stoppedAt,
          stoppedAt,
          processed,
        },
        $unset: {
          currentRequestId: '',
          currentSourceId: '',
          currentCandidateId: '',
          currentExecutionMode: '',
        },
      },
    ).catch(() => {});
    await client.close();
  }
};
