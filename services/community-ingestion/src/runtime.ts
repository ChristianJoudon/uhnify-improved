import { randomUUID } from 'node:crypto';
import type { ArtifactStore } from './artifact-store.js';
import { recurringSeriesKeysFor, suggestClassification } from './classification.js';
import {
  SourceDefinitionSchema,
  assertAdapter,
  type FetchArtifactInput,
  type SourceAdapter,
  type SourceDefinition,
} from './contracts.js';
import { sha256, stableHash } from './hash.js';
import { filterOperationalResponseHeaders } from './safe-http-client.js';
import type {
  ArtifactRecord,
  CandidateRecord,
  IngestionRepository,
  ObservationRecord,
  RunMetrics,
} from './repository.js';

export type RunArtifactInput = FetchArtifactInput & {
  source: SourceDefinition;
  adapter: SourceAdapter;
  execution: 'automatic' | 'manual' | 'practice' | 'fixture';
  scheduledFor?: Date;
};

const allowlistedFields = (fields: Record<string, unknown>, allowlist: string[]): Record<string, unknown> => {
  const allowed = new Set(allowlist);
  return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)));
};

const summaryFor = (fields: Record<string, unknown>): CandidateRecord['summary'] => {
  const title = typeof fields.title === 'string' ? fields.title : 'Untitled candidate';
  const when = typeof fields.localStart === 'string' ? fields.localStart : undefined;
  const location = typeof fields.location === 'string' ? fields.location : undefined;
  return { title, ...(when ? { when } : {}), ...(location ? { location } : {}) };
};

const blockingKeysFor = (fields: Record<string, unknown>): string[] => {
  const values = ['title', 'localStart', 'location']
    .map(key => fields[key])
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase().replace(/\s+/g, ' '));
  return values.length ? [sha256(values.join('|'))] : [];
};

const SENSITIVE_FORBIDDEN_KEY = /(attendee|participant|memberlist|personalcontact|phone|email|zoom|passcode|password|meetingid|healthstatus|diagnosis)/i;
const SENSITIVE_FORBIDDEN_VALUE = /(zoom\.us|\bpasscode\b|\bmeeting\s+id\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:^|\D)(?:\+?1[\s().-]*)?(?:\(?[2-9]\d{2}\)?[\s().-]*)?[2-9]\d{2}[\s.-]*\d{4}(?:\D|$)|(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/i;

const assertSensitivePayload = (value: unknown, path = 'normalizedFields', allowedSourceUrl?: string): void => {
  if (typeof value === 'string') {
    const isApprovedSourceUrl = path.endsWith('.sourceUrl') && value === allowedSourceUrl;
    if (!isApprovedSourceUrl && SENSITIVE_FORBIDDEN_VALUE.test(value)) {
      throw new Error(`Sensitive support payload contains prohibited access/contact data at ${path}`);
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSensitivePayload(item, `${path}[${index}]`, allowedSourceUrl));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    if (SENSITIVE_FORBIDDEN_KEY.test(key.replaceAll('_', ''))) {
      throw new Error(`Sensitive support payload contains prohibited field ${path}.${key}`);
    }
    assertSensitivePayload(item, `${path}.${key}`, allowedSourceUrl);
  });
};

const errorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'INGESTION_FAILED';
};

export class IngestionRuntime {
  private readonly repository: IngestionRepository;
  private readonly artifacts: ArtifactStore;

  constructor(repository: IngestionRepository, artifacts: ArtifactStore) {
    this.repository = repository;
    this.artifacts = artifacts;
  }

  private assertRunnable(source: SourceDefinition, execution: RunArtifactInput['execution']): void {
    if (execution === 'automatic' && (!source.enabled || source.permission !== 'AUTOMATED_ALLOWED')) {
      throw new Error(`Source ${source.id} is not approved for automatic collection`);
    }
    if (execution === 'manual' && !['MANUAL_ONLY', 'AUTOMATED_ALLOWED'].includes(source.permission)) {
      throw new Error(`Source ${source.id} is not approved for manual collection`);
    }
    if (execution === 'practice' && source.permission !== 'PROBE_REQUIRED') {
      throw new Error(`Source ${source.id} is not awaiting a practice probe`);
    }
    if (execution === 'fixture' && source.adapterKind !== 'SYNTHETIC_FIXTURE') {
      throw new Error('Fixture execution is reserved for the synthetic test adapter');
    }
  }

  async runArtifact(input: RunArtifactInput): Promise<{ runId: string; completeness: 'COMPLETE' | 'PARTIAL'; metrics: RunMetrics }> {
    const source = SourceDefinitionSchema.parse(input.source);
    const sensitiveSupport = /^SEN-\d{3}$/.test(source.id);
    this.assertRunnable(source, input.execution);
    assertAdapter(input.adapter, source);
    await this.repository.ensureIndexes();
    const scheduledFor = input.scheduledFor ?? new Date();
    const runId = await this.repository.startRun(source.id, scheduledFor);

    const metrics: RunMetrics = {
      discovered: 0,
      emitted: 0,
      rejected: 0,
      artifactsCreated: 0,
      observationsCreated: 0,
      candidatesCreated: 0,
      unchanged: false,
    };

    try {
      if (sensitiveSupport && typeof input.adapter.prepareArtifactForStorage !== 'function') {
        throw new Error(`Sensitive source ${source.id} requires pre-storage artifact validation`);
      }
      const preparedBytes = input.adapter.prepareArtifactForStorage
        ? await input.adapter.prepareArtifactForStorage(input, source)
        : input.bytes;
      if (!(preparedBytes instanceof Uint8Array)) {
        throw new Error(`Adapter ${input.adapter.kind} returned invalid prepared artifact bytes`);
      }
      // Copy the adapter-approved payload so the exact bytes validated here are
      // the bytes persisted and parsed for the remainder of this run.
      const artifactInput: RunArtifactInput = { ...input, bytes: preparedBytes.slice() };

      const stored = await this.artifacts.put(artifactInput.bytes);
      const proposedArtifact: ArtifactRecord = {
        id: randomUUID(),
        sourceId: source.id,
        contentHash: stored.contentHash,
        observedAt: new Date(),
        byteLength: stored.byteLength,
        mediaType: artifactInput.mediaType,
        sourceUrl: artifactInput.sourceUrl,
        statusCode: artifactInput.statusCode,
        responseHeaders: filterOperationalResponseHeaders(artifactInput.responseHeaders),
        storagePath: stored.storagePath,
      };
      const artifact = await this.repository.putArtifact(proposedArtifact);
      if (artifact.created) metrics.artifactsCreated += 1;

      const previousCompleteness = await this.repository.parseRunCompleteness(
        artifact.id,
        source.parser.parserId,
        source.parser.parserVersion,
      );
      if (previousCompleteness) metrics.unchanged = true;

      const result = await input.adapter.extract(artifactInput, source);
      metrics.discovered = result.metrics.discovered;
      metrics.emitted = result.metrics.emitted;
      metrics.rejected = result.metrics.rejected;
      const recurringSeriesKeys = recurringSeriesKeysFor(source.id, result.items);

      for (const item of result.items) {
        if (sensitiveSupport) {
          assertSensitivePayload(item.rawFields, 'rawFields', item.canonicalSourceUrl);
          assertSensitivePayload(item.normalizedFields, 'normalizedFields', item.canonicalSourceUrl);
        }
        const sourceItemKey = input.adapter.stableItemKey(item);
        if (!sourceItemKey || sourceItemKey !== item.sourceItemKey) {
          throw new Error('Adapter returned an unstable or inconsistent source item key');
        }
        const rawFields = allowlistedFields(item.rawFields, source.fieldAllowlist);
        const itemContentHash = stableHash(rawFields);
        const observationId = stableHash({
          sourceId: source.id,
          sourceItemKey,
          itemContentHash,
          parserVersion: source.parser.parserVersion,
        });
        const evidence = item.evidence.map(pointer => {
          const excerpt = sensitiveSupport ? undefined : pointer.excerpt?.slice(0, 500);
          const base = {
            artifactId: artifact.id,
            sourceUrl: item.canonicalSourceUrl,
            locatorKind: pointer.locatorKind,
            locator: pointer.locator,
            excerptHash: sha256(excerpt ?? ''),
          };
          return { id: stableHash(base), ...base, ...(excerpt ? { excerpt } : {}) };
        });
        const observation: ObservationRecord = {
          id: observationId,
          sourceId: source.id,
          runId,
          artifactId: artifact.id,
          observedAt: new Date(),
          sourceItemKey,
          canonicalSourceUrl: item.canonicalSourceUrl,
          itemContentHash,
          parserId: source.parser.parserId,
          parserVersion: source.parser.parserVersion,
          entityHint: item.entityHint,
          rawFields,
          evidence,
          ...(item.explicitRealityHint ? { explicitRealityHint: item.explicitRealityHint } : {}),
        };
        const storedObservation = await this.repository.putObservation(observation);
        if (storedObservation.created) metrics.observationsCreated += 1;

        const parentSourceItemKey = item.entityHint === 'event'
          && typeof item.rawFields.groupKey === 'string'
          ? `group:${item.rawFields.groupKey}`
          : undefined;
        const legacyRelationshipFingerprint = stableHash({
          sourceId: source.id,
          sourceItemKey,
          normalizedFields: item.normalizedFields,
        });
        // Parent membership is an editorial relationship, so event moves need
        // a new revision. Classification and series keys are deterministic
        // derivatives of normalized facts already in this hash; hashing those
        // derivatives again would only churn legacy candidates on version bumps.
        const fingerprint = parentSourceItemKey ? stableHash({
          sourceId: source.id,
          sourceItemKey,
          parentSourceItemKey,
          normalizedFields: item.normalizedFields,
        }) : legacyRelationshipFingerprint;
        const classificationSuggestion = item.entityHint === 'event' || item.entityHint === 'group'
          ? suggestClassification({
            entityHint: item.entityHint,
            normalizedFields: item.normalizedFields,
            source,
          })
          : undefined;
        const recurringSeriesKey = recurringSeriesKeys.get(item.sourceItemKey);
        const observedAt = new Date();
        const candidate: CandidateRecord = {
          id: fingerprint,
          sourceId: source.id,
          sourceItemKey,
          entityHint: item.entityHint,
          ...(parentSourceItemKey ? { parentSourceItemKey } : {}),
          observationId: storedObservation.id,
          fingerprint,
          blockingKeys: blockingKeysFor(item.normalizedFields),
          normalizedFields: item.normalizedFields,
          summary: summaryFor(item.normalizedFields),
          ...(classificationSuggestion ? { classificationSuggestion } : {}),
          ...(recurringSeriesKey ? { recurringSeriesKey } : {}),
          validationState: item.entityHint === 'group'
            || (typeof item.normalizedFields.localStart === 'string'
              && !Number.isNaN(Date.parse(item.normalizedFields.localStart)))
            || (typeof item.normalizedFields.recurrenceLabel === 'string'
              && item.normalizedFields.recurrenceLabel.trim().length > 0)
            ? 'VALID'
            : 'INVALID',
          reviewStatus: 'PENDING',
          ...(sensitiveSupport ? {
            reviewLane: 'SENSITIVE' as const,
            privacyReviewRequired: true,
            sensitivePolicyVersion: 'sensitive-schedule.v1',
            projectionEligibility: 'REQUIRES_SENSITIVE_REVIEW' as const,
          } : {}),
          createdAt: observedAt,
          lastObservedAt: observedAt,
        };
        const storedCandidate = await this.repository.upsertCandidate(
          candidate,
          parentSourceItemKey ? legacyRelationshipFingerprint : undefined,
        );
        if (storedCandidate.created) metrics.candidatesCreated += 1;
      }

      const completeness = previousCompleteness ?? result.completeness;
      await this.repository.recordParseRun(
        artifact.id,
        source.parser.parserId,
        source.parser.parserVersion,
        runId,
        completeness,
      );
      await this.repository.finishRun(runId, completeness, metrics);
      await this.repository.recordHealth(
        source.id,
        completeness,
        completeness === 'PARTIAL' ? 'PARTIAL_RUN' : undefined,
      );
      return { runId, completeness, metrics };
    } catch (error) {
      const code = errorCode(error);
      await this.repository.failRun(runId, code);
      await this.repository.recordHealth(source.id, 'FAILED', code);
      throw error;
    }
  }
}
