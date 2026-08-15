import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ManualSupportAdapter } from '../src/adapters/manual-support.js';
import { FileArtifactStore } from '../src/artifact-store.js';
import { SourceDefinitionSchema, type SourceAdapter, type SourceDefinition } from '../src/contracts.js';
import { stableHash } from '../src/hash.js';
import { MemoryIngestionRepository, type CandidateRecord } from '../src/repository.js';
import { IngestionRuntime } from '../src/runtime.js';

const fixtureUrl = (sourceId: string): URL => new URL(`../fixtures/support/${sourceId}.json`, import.meta.url);

const manualSource = (sourceId: string, sourceUrl: string): SourceDefinition => {
  const host = new URL(sourceUrl).hostname;
  return SourceDefinitionSchema.parse({
    id: sourceId,
    slug: sourceId.toLowerCase(),
    displayName: `${sourceId} support snapshot`,
    publisherName: 'Official support publisher',
    publisherUrl: new URL('/', sourceUrl).toString(),
    tier: 'X',
    adapterKind: 'MANUAL_CLIP',
    adapterConfig: { kind: 'MANUAL_CLIP' },
    endpoints: [{ purpose: 'COLLECTION', method: 'GET', urlTemplate: sourceUrl }],
    trust: 'OFFICIAL_ORGANIZER',
    permission: 'MANUAL_ONLY',
    contentKinds: ['event', 'group'],
    polling: {
      intervalMinutes: 43_200,
      jitterPercent: 0,
      lookBackDays: 0,
      lookAheadDays: 366,
      maxPages: 1,
      maxItems: 500,
    },
    httpPolicy: {
      allowedHosts: [host],
      allowedRedirectHosts: [],
      allowedMediaTypes: ['application/json'],
      timeoutMs: 1_000,
      maxResponseBytes: 1_000_000,
      maxRedirects: 0,
      minimumDelayMs: 0,
    },
    parser: {
      parserId: 'manual-support',
      parserVersion: '1.0.0',
      fixtureVersion: 'support-snapshot.v1',
    },
    fieldAllowlist: [
      'groupKey',
      'title',
      'listingType',
      'supportSubtype',
      'recurrenceLabel',
      'recurrenceLabels',
      'timeZone',
      'location',
      'locationLabels',
      'formatLabels',
      'sourceUrl',
      'verifiedAt',
      'reviewFlags',
      'realityStatus',
    ],
    authorityByField: { title: 'OFFICIAL_ORGANIZER' },
    enabled: false,
    nextRunAt: '2026-09-08T00:00:00.000Z',
    lastVerifiedAt: '2026-08-08T22:00:00.000Z',
    steward: 'MatchBook curation',
  });
};

const extractBytes = async (bytes: Uint8Array, sourceId: string, sourceUrl: string, options?: {
  mediaType?: string;
  statusCode?: number;
}) => new ManualSupportAdapter().extract({
  bytes,
  mediaType: options?.mediaType ?? 'application/json',
  sourceUrl,
  statusCode: options?.statusCode ?? 200,
  responseHeaders: {},
}, manualSource(sourceId, sourceUrl));

const extractDocument = async (document: unknown, sourceId = 'SEN-900', sourceUrl = 'https://support.example/schedule') =>
  extractBytes(new TextEncoder().encode(JSON.stringify(document)), sourceId, sourceUrl);

const safeSnapshot = () => ({
  schemaVersion: 'support-snapshot.v1',
  sourceId: 'SEN-900',
  sourceUrl: 'https://support.example/schedule',
  verifiedAt: '2026-08-08T12:00:00-10:00',
  completeness: 'COMPLETE',
  reviewFlags: ['MANUAL_SOURCE_CAPTURE'],
  listings: [{
    sourceItemKey: 'sample-tue-1300',
    groupKey: 'sample-group',
    name: 'Sample Support Group',
    supportSubtype: 'mental_health_peer',
    recurrenceLabel: 'Tuesday at 1:00 pm',
    timeZone: 'Pacific/Honolulu',
    locationLabel: 'Public Library, Lihue',
    formatLabels: ['In person'],
  }],
});

test('committed support snapshots emit privacy-safe group and event candidates', async () => {
  const expected = [
    { sourceId: 'SEN-001', sourceUrl: 'https://kauaimeetings.com/locations/', completeness: 'PARTIAL', listings: 57, groups: 27, emitted: 84 },
    { sourceId: 'SEN-002', sourceUrl: 'https://na-hawaii.org/meeting-schedules/kauai-island/', completeness: 'COMPLETE', listings: 15, groups: 14, emitted: 29 },
    { sourceId: 'SEN-003', sourceUrl: 'https://www.al-anonhawaii.org/kauai', completeness: 'COMPLETE', listings: 6, groups: 6, emitted: 12 },
    { sourceId: 'SEN-004', sourceUrl: 'https://kauai.namihawaii.org/', completeness: 'PARTIAL', listings: 4, groups: 2, emitted: 6 },
    { sourceId: 'SEN-005', sourceUrl: 'https://www.alz.org/hawaii/support', completeness: 'COMPLETE', listings: 3, groups: 3, emitted: 6 },
  ] as const;

  let totalDiscovered = 0;
  let totalGroups = 0;
  let totalEvents = 0;
  for (const fixture of expected) {
    const bytes = await readFile(fixtureUrl(fixture.sourceId));
    const result = await extractBytes(bytes, fixture.sourceId, fixture.sourceUrl);
    const groups = result.items.filter(item => item.entityHint === 'group');
    const events = result.items.filter(item => item.entityHint === 'event');

    assert.equal(result.completeness, fixture.completeness, fixture.sourceId);
    assert.deepEqual(result.metrics, {
      discovered: fixture.listings,
      emitted: fixture.emitted,
      rejected: 0,
    });
    assert.equal(groups.length, fixture.groups, `${fixture.sourceId} group count`);
    assert.equal(events.length, fixture.listings, `${fixture.sourceId} event count`);
    assert.equal(new Set(result.items.map(item => item.sourceItemKey)).size, result.items.length);

    for (const item of result.items) {
      assert.equal(item.canonicalSourceUrl, fixture.sourceUrl);
      assert.equal(item.normalizedFields.listingType, 'support_group');
      assert.equal(typeof item.normalizedFields.supportSubtype, 'string');
      assert.equal(item.normalizedFields.sourceUrl, fixture.sourceUrl);
      assert.ok(Array.isArray(item.normalizedFields.formatLabels));
      assert.ok(Array.isArray(item.normalizedFields.reviewFlags));
      assert.ok((item.normalizedFields.reviewFlags as string[]).includes('MANUAL_SOURCE_CAPTURE'));
      if (item.entityHint === 'group') {
        assert.ok(Array.isArray(item.normalizedFields.recurrenceLabels));
        assert.ok(Array.isArray(item.normalizedFields.locationLabels));
      } else {
        assert.equal(typeof item.normalizedFields.recurrenceLabel, 'string');
        assert.equal(item.explicitRealityHint, 'SCHEDULED');
      }
    }

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /zoom\.us|\b(?:zoom|meeting)\s*(?:id|link)\b|\b(?:passcode|password)\b/i);
    assert.doesNotMatch(serialized, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    assert.doesNotMatch(serialized, /(?:^|\D)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?:\D|$)/);
    assert.doesNotMatch(serialized, /"(?:attendee|attendees|contact|email|phone|zoomId|zoomUrl|passcode)"/i);

    totalDiscovered += result.metrics.discovered;
    totalGroups += groups.length;
    totalEvents += events.length;
  }

  assert.deepEqual({ totalDiscovered, totalGroups, totalEvents }, {
    totalDiscovered: 85,
    totalGroups: 52,
    totalEvents: 85,
  });
});

test('manual adapter plans no network requests', async () => {
  const source = manualSource('SEN-900', 'https://support.example/schedule');
  assert.deepEqual(await new ManualSupportAdapter().planRequests(source), []);
});

test('manual snapshot crosses the runtime boundary as separate group and event candidates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-support-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const sourceUrl = 'https://support.example/schedule';
  const snapshot = safeSnapshot();
  const runtime = new IngestionRuntime(repository, new FileArtifactStore(root));
  const runInput = {
    bytes: new TextEncoder().encode(JSON.stringify(snapshot)),
    mediaType: 'application/json',
    sourceUrl,
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    source: manualSource('SEN-900', sourceUrl),
    adapter: new ManualSupportAdapter(),
    execution: 'manual' as const,
  };
  const result = await runtime.runArtifact(runInput);

  assert.deepEqual(result.metrics, {
    discovered: 1,
    emitted: 2,
    rejected: 0,
    artifactsCreated: 1,
    observationsCreated: 2,
    candidatesCreated: 2,
    unchanged: false,
  });
  assert.deepEqual(
    [...repository.observations.values()].map(observation => observation.entityHint).sort(),
    ['event', 'group'],
  );
  assert.equal(repository.candidates.size, 2);
  for (const candidate of repository.candidates.values()) {
    assert.equal(candidate.normalizedFields.listingType, 'support_group');
    assert.equal(candidate.normalizedFields.supportSubtype, 'mental_health_peer');
    assert.equal(candidate.reviewStatus, 'PENDING');
  }

  const reorderedSnapshot = {
    listings: snapshot.listings,
    reviewFlags: snapshot.reviewFlags,
    completeness: snapshot.completeness,
    verifiedAt: snapshot.verifiedAt,
    sourceUrl: snapshot.sourceUrl,
    sourceId: snapshot.sourceId,
    schemaVersion: snapshot.schemaVersion,
  };
  const replay = await runtime.runArtifact({
    ...runInput,
    bytes: new TextEncoder().encode(JSON.stringify(reorderedSnapshot)),
  });
  assert.deepEqual(replay.metrics, {
    discovered: 1,
    emitted: 2,
    rejected: 0,
    artifactsCreated: 0,
    observationsCreated: 0,
    candidatesCreated: 0,
    unchanged: true,
  });
  assert.equal(repository.artifacts.size, 1, 'canonical safe bytes preserve content-addressed replay');
  assert.equal(repository.observations.size, 2);
  assert.equal(repository.candidates.size, 2);
});

test('moving an event creates relationship revisions without reopening approved decisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-support-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const sourceUrl = 'https://support.example/schedule';
  const source = manualSource('SEN-900', sourceUrl);
  const adapter = new ManualSupportAdapter();
  const runtime = new IngestionRuntime(repository, new FileArtifactStore(root));
  const firstSnapshot = safeSnapshot();

  await runtime.runArtifact({
    bytes: new TextEncoder().encode(JSON.stringify(firstSnapshot)),
    mediaType: 'application/json',
    sourceUrl,
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    source,
    adapter,
    execution: 'manual',
  });

  const originalEvent = [...repository.candidates.values()]
    .find(candidate => candidate.entityHint === 'event');
  assert.ok(originalEvent);
  assert.equal(originalEvent.parentSourceItemKey, 'group:sample-group');

  const movedSnapshot = safeSnapshot();
  const movedListing = movedSnapshot.listings[0];
  assert.ok(movedListing);
  movedListing.groupKey = 'replacement-group';
  await runtime.runArtifact({
    bytes: new TextEncoder().encode(JSON.stringify(movedSnapshot)),
    mediaType: 'application/json',
    sourceUrl,
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    source,
    adapter,
    execution: 'manual',
  });

  const eventCandidates = [...repository.candidates.values()]
    .filter(candidate => candidate.entityHint === 'event');
  assert.equal(eventCandidates.length, 2);
  const movedEvent = eventCandidates
    .find(candidate => candidate.parentSourceItemKey === 'group:replacement-group');
  assert.ok(movedEvent);
  assert.equal(movedEvent.sourceItemKey, originalEvent.sourceItemKey);
  assert.deepEqual(movedEvent.normalizedFields, originalEvent.normalizedFields);
  assert.notEqual(movedEvent.fingerprint, originalEvent.fingerprint);
  assert.equal(originalEvent.reviewStatus, 'SUPERSEDED');
  assert.equal(movedEvent.reviewStatus, 'PENDING');

  movedEvent.reviewStatus = 'APPROVED';
  const approvedFingerprint = movedEvent.fingerprint;
  const approvedObservationId = movedEvent.observationId;
  const finalSnapshot = safeSnapshot();
  const finalListing = finalSnapshot.listings[0];
  assert.ok(finalListing);
  finalListing.groupKey = 'final-group';
  await runtime.runArtifact({
    bytes: new TextEncoder().encode(JSON.stringify(finalSnapshot)),
    mediaType: 'application/json',
    sourceUrl,
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    source,
    adapter,
    execution: 'manual',
  });

  const approvedEvent = repository.candidates.get(approvedFingerprint);
  assert.equal(approvedEvent, movedEvent);
  assert.equal(approvedEvent.reviewStatus, 'APPROVED');
  assert.equal(approvedEvent.parentSourceItemKey, 'group:replacement-group');
  assert.equal(approvedEvent.observationId, approvedObservationId);
  const finalEvent = [...repository.candidates.values()]
    .find(candidate => candidate.parentSourceItemKey === 'group:final-group');
  assert.ok(finalEvent);
  assert.equal(finalEvent.sourceItemKey, approvedEvent.sourceItemKey);
  assert.deepEqual(finalEvent.normalizedFields, approvedEvent.normalizedFields);
  assert.notEqual(finalEvent.fingerprint, approvedEvent.fingerprint);
  assert.equal(finalEvent.reviewStatus, 'PENDING');
  for (const groupCandidate of repository.candidates.values()) {
    if (groupCandidate.entityHint === 'group') {
      assert.equal(groupCandidate.parentSourceItemKey, undefined);
    }
  }
});

test('exact artifact reversion reopens the earlier approved relationship for republication', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-support-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const sourceUrl = 'https://support.example/schedule';
  const source = manualSource('SEN-900', sourceUrl);
  const adapter = new ManualSupportAdapter();
  const runtime = new IngestionRuntime(repository, new FileArtifactStore(root));
  const firstSnapshot = safeSnapshot();
  const firstBytes = new TextEncoder().encode(JSON.stringify(firstSnapshot));
  const runInput = {
    bytes: firstBytes,
    mediaType: 'application/json',
    sourceUrl,
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    source,
    adapter,
    execution: 'manual' as const,
  };

  await runtime.runArtifact(runInput);
  const firstEvent = [...repository.candidates.values()]
    .find(candidate => candidate.entityHint === 'event');
  assert.ok(firstEvent);
  firstEvent.reviewStatus = 'APPROVED';
  firstEvent.lastObservedAt = new Date('2000-01-01T00:00:00.000Z');

  const secondSnapshot = safeSnapshot();
  const secondListing = secondSnapshot.listings[0];
  assert.ok(secondListing);
  secondListing.groupKey = 'replacement-group';
  await runtime.runArtifact({
    ...runInput,
    bytes: new TextEncoder().encode(JSON.stringify(secondSnapshot)),
  });
  const secondEvent = [...repository.candidates.values()]
    .find(candidate => candidate.parentSourceItemKey === 'group:replacement-group');
  assert.ok(secondEvent);
  secondEvent.reviewStatus = 'APPROVED';
  secondEvent.lastObservedAt = new Date('2001-01-01T00:00:00.000Z');

  const countsBeforeReversion = {
    artifacts: repository.artifacts.size,
    observations: repository.observations.size,
    candidates: repository.candidates.size,
    parseRuns: repository.parseRuns.size,
  };
  const reverted = await runtime.runArtifact(runInput);

  assert.deepEqual(reverted.metrics, {
    discovered: 1,
    emitted: 2,
    rejected: 0,
    artifactsCreated: 0,
    observationsCreated: 0,
    candidatesCreated: 0,
    unchanged: true,
  });
  assert.deepEqual({
    artifacts: repository.artifacts.size,
    observations: repository.observations.size,
    candidates: repository.candidates.size,
    parseRuns: repository.parseRuns.size,
  }, countsBeforeReversion);
  assert.equal(firstEvent.reviewStatus, 'PENDING');
  assert.equal(secondEvent.reviewStatus, 'APPROVED');
  assert.ok(firstEvent.lastObservedAt.getTime() > secondEvent.lastObservedAt.getTime());
  const latestEvent = [...repository.candidates.values()]
    .filter(candidate => candidate.entityHint === 'event')
    .reduce((latest, candidate) => (
      candidate.lastObservedAt.getTime() > latest.lastObservedAt.getTime() ? candidate : latest
    ));
  assert.equal(latestEvent, firstEvent, 'the reverted A fingerprint is current and requires review');
});

test('unchanged legacy relationship is reused and backfilled from immutable observation evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-support-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const sourceUrl = 'https://support.example/schedule';
  const source = manualSource('SEN-900', sourceUrl);
  const adapter = new ManualSupportAdapter();
  const snapshot = safeSnapshot();
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const extraction = await adapter.extract({
    bytes,
    mediaType: 'application/json',
    sourceUrl,
    statusCode: 200,
    responseHeaders: {},
  }, source);
  const eventItem = extraction.items.find(item => item.entityHint === 'event');
  assert.ok(eventItem);
  const legacyFingerprint = stableHash({
    sourceId: source.id,
    sourceItemKey: eventItem.sourceItemKey,
    normalizedFields: eventItem.normalizedFields,
  });
  const legacyObservedAt = new Date('2026-08-08T22:00:00.000Z');
  await repository.putObservation({
    id: 'legacy-observation',
    sourceId: source.id,
    runId: 'legacy-run',
    artifactId: 'legacy-artifact',
    observedAt: legacyObservedAt,
    sourceItemKey: eventItem.sourceItemKey,
    canonicalSourceUrl: eventItem.canonicalSourceUrl,
    itemContentHash: 'legacy-content-hash',
    parserId: source.parser.parserId,
    parserVersion: source.parser.parserVersion,
    entityHint: 'event',
    rawFields: eventItem.rawFields,
    evidence: [],
  });
  const legacyCandidate: CandidateRecord = {
    id: legacyFingerprint,
    sourceId: source.id,
    sourceItemKey: eventItem.sourceItemKey,
    entityHint: 'event',
    observationId: 'legacy-observation',
    fingerprint: legacyFingerprint,
    blockingKeys: [],
    normalizedFields: eventItem.normalizedFields,
    summary: { title: 'Sample Support Group' },
    validationState: 'VALID',
    reviewStatus: 'PENDING',
    createdAt: legacyObservedAt,
    lastObservedAt: legacyObservedAt,
  };
  await repository.upsertCandidate(legacyCandidate);

  const runtime = new IngestionRuntime(repository, new FileArtifactStore(root));
  const unchanged = await runtime.runArtifact({
    bytes,
    mediaType: 'application/json',
    sourceUrl,
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    source,
    adapter,
    execution: 'manual',
  });

  assert.equal(unchanged.metrics.candidatesCreated, 1, 'only the missing group candidate is new');
  assert.equal(
    [...repository.candidates.values()].filter(candidate => candidate.entityHint === 'event').length,
    1,
  );
  assert.equal(legacyCandidate.fingerprint, legacyFingerprint);
  assert.equal(legacyCandidate.parentSourceItemKey, 'group:sample-group');
  assert.notEqual(legacyCandidate.observationId, 'legacy-observation');

  const movedSnapshot = safeSnapshot();
  const movedListing = movedSnapshot.listings[0];
  assert.ok(movedListing);
  movedListing.groupKey = 'replacement-group';
  await runtime.runArtifact({
    bytes: new TextEncoder().encode(JSON.stringify(movedSnapshot)),
    mediaType: 'application/json',
    sourceUrl,
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    source,
    adapter,
    execution: 'manual',
  });

  const movedEvent = [...repository.candidates.values()]
    .find(candidate => candidate.parentSourceItemKey === 'group:replacement-group');
  assert.ok(movedEvent);
  assert.notEqual(movedEvent.fingerprint, legacyCandidate.fingerprint);
  assert.equal(legacyCandidate.reviewStatus, 'SUPERSEDED');
  assert.equal(movedEvent.reviewStatus, 'PENDING');
});

test('phone formats are rejected before artifact persistence', async t => {
  const sourceUrl = 'https://support.example/schedule';
  for (const unsafeValue of ['Call 8085550199', 'Call (808)555-0199', 'Call 555-0199']) {
    const root = await mkdtemp(join(tmpdir(), 'matchbook-support-ingestion-'));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const repository = new MemoryIngestionRepository();
    const unsafe = safeSnapshot();
    const listing = unsafe.listings[0];
    assert.ok(listing);
    listing.locationLabel = unsafeValue;

    await assert.rejects(
      new IngestionRuntime(repository, new FileArtifactStore(root)).runArtifact({
        bytes: new TextEncoder().encode(JSON.stringify(unsafe)),
        mediaType: 'application/json',
        sourceUrl,
        statusCode: 200,
        responseHeaders: { 'content-type': 'application/json' },
        source: manualSource('SEN-900', sourceUrl),
        adapter: new ManualSupportAdapter(),
        execution: 'manual',
      }),
      /phone numbers are prohibited/,
    );

    assert.equal(repository.artifacts.size, 0);
    assert.equal(repository.parseRuns.size, 0);
    assert.equal(repository.observations.size, 0);
    assert.equal(repository.candidates.size, 0);
    assert.deepEqual(await readdir(root), [], `${unsafeValue} must never reach the artifact store`);
  }
});

test('private meeting URL is rejected before artifact persistence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-support-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const sourceUrl = 'https://support.example/schedule';
  const unsafe = safeSnapshot();
  const listing = unsafe.listings[0];
  assert.ok(listing);
  listing.locationLabel = 'https://meet.google.com/private-room';

  await assert.rejects(
    new IngestionRuntime(repository, new FileArtifactStore(root)).runArtifact({
      bytes: new TextEncoder().encode(JSON.stringify(unsafe)),
      mediaType: 'application/json',
      sourceUrl,
      statusCode: 200,
      responseHeaders: { 'content-type': 'application/json' },
      source: manualSource('SEN-900', sourceUrl),
      adapter: new ManualSupportAdapter(),
      execution: 'manual',
    }),
    /URLs and private access links are prohibited/,
  );

  assert.equal(repository.artifacts.size, 0);
  assert.equal(repository.parseRuns.size, 0);
  assert.equal(repository.observations.size, 0);
  assert.equal(repository.candidates.size, 0);
  assert.deepEqual(await readdir(root), [], 'private meeting links must never reach the artifact store');
});

test('sensitive source fails closed when its adapter omits pre-storage validation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-support-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const sourceUrl = 'https://support.example/schedule';
  const guardedAdapter = new ManualSupportAdapter();
  const unguardedAdapter = {
    kind: guardedAdapter.kind,
    planRequests: guardedAdapter.planRequests.bind(guardedAdapter),
    extract: guardedAdapter.extract.bind(guardedAdapter),
    stableItemKey: guardedAdapter.stableItemKey.bind(guardedAdapter),
  } satisfies SourceAdapter;

  await assert.rejects(
    new IngestionRuntime(repository, new FileArtifactStore(root)).runArtifact({
      bytes: new TextEncoder().encode(JSON.stringify(safeSnapshot())),
      mediaType: 'application/json',
      sourceUrl,
      statusCode: 200,
      responseHeaders: {},
      source: manualSource('SEN-900', sourceUrl),
      adapter: unguardedAdapter,
      execution: 'manual',
    }),
    /requires pre-storage artifact validation/,
  );

  assert.equal(repository.artifacts.size, 0);
  assert.equal(repository.observations.size, 0);
  assert.equal(repository.candidates.size, 0);
  assert.deepEqual(await readdir(root), []);
});

test('manual snapshot schema rejects unknown and privacy-sensitive fields or values', async t => {
  const base = safeSnapshot();
  const listing = base.listings[0];
  assert.ok(listing);
  const cases: Array<{ name: string; document: unknown; message: RegExp }> = [
    {
      name: 'unknown top-level key',
      document: { ...base, unexpected: true },
      message: /Unrecognized key/,
    },
    {
      name: 'unknown listing key',
      document: { ...base, listings: [{ ...listing, note: 'not allowlisted' }] },
      message: /Unrecognized key/,
    },
    {
      name: 'phone field',
      document: { ...base, listings: [{ ...listing, phone: 'redacted' }] },
      message: /Prohibited privacy field phone/,
    },
    {
      name: 'attendee identity',
      document: { ...base, listings: [{ ...listing, attendees: ['Private Person'] }] },
      message: /Prohibited privacy field attendees/,
    },
    {
      name: 'phone value in an allowed field',
      document: { ...base, listings: [{ ...listing, locationLabel: 'Call (808) 555-0199' }] },
      message: /phone numbers are prohibited/,
    },
    {
      name: 'compact phone value in an allowed field',
      document: { ...base, listings: [{ ...listing, locationLabel: 'Call 8085550199' }] },
      message: /phone numbers are prohibited/,
    },
    {
      name: 'phone value without an area-code separator',
      document: { ...base, listings: [{ ...listing, locationLabel: 'Call (808)555-0199' }] },
      message: /phone numbers are prohibited/,
    },
    {
      name: 'local seven-digit phone value',
      document: { ...base, listings: [{ ...listing, locationLabel: 'Call 555-0199' }] },
      message: /phone numbers are prohibited/,
    },
    {
      name: 'email value in an allowed field',
      document: { ...base, listings: [{ ...listing, locationLabel: 'helper@example.org' }] },
      message: /email addresses are prohibited/,
    },
    {
      name: 'Zoom URL',
      document: { ...base, sourceUrl: 'https://zoom.us/j/123456789' },
      message: /Zoom URLs are prohibited/,
    },
    {
      name: 'private meeting URL in an allowed field',
      document: { ...base, listings: [{ ...listing, locationLabel: 'https://meet.google.com/private-room' }] },
      message: /URLs and private access links are prohibited/,
    },
    {
      name: 'Zoom ID',
      document: { ...base, listings: [{ ...listing, formatLabels: ['Zoom ID 123456789'] }] },
      message: /online meeting identifiers are prohibited/,
    },
    {
      name: 'passcode',
      document: { ...base, listings: [{ ...listing, formatLabels: ['Passcode 1234'] }] },
      message: /online meeting credentials are prohibited/,
    },
  ];

  for (const privacyCase of cases) {
    await t.test(privacyCase.name, async () => {
      await assert.rejects(extractDocument(privacyCase.document), privacyCase.message);
    });
  }
});

test('manual snapshot requires explicit completeness and matching provenance', async () => {
  const base = safeSnapshot();
  await assert.rejects(
    extractDocument({ ...base, completeness: 'PARTIAL' }),
    /PARTIAL snapshots must carry PARTIAL_SOURCE_SNAPSHOT/,
  );
  await assert.rejects(
    extractDocument({ ...base, sourceId: 'SEN-901' }),
    /does not match SEN-900/,
  );
  await assert.rejects(
    extractDocument({ ...base, sourceUrl: 'https://support.example/other' }),
    /must match the artifact sourceUrl/,
  );
  await assert.rejects(
    extractBytes(new TextEncoder().encode(JSON.stringify(base)), 'SEN-900', base.sourceUrl, { mediaType: 'text/plain' }),
    /must use application\/json/,
  );
  await assert.rejects(
    extractBytes(new TextEncoder().encode(JSON.stringify(base)), 'SEN-900', base.sourceUrl, { statusCode: 201 }),
    /require status code 200/,
  );
});
