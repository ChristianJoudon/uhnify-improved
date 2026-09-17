import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SyntheticFixtureAdapter } from '../src/adapters/synthetic-fixture.js';
import { FileArtifactStore } from '../src/artifact-store.js';
import { stableHash } from '../src/hash.js';
import { MemoryIngestionRepository } from '../src/repository.js';
import { IngestionRuntime } from '../src/runtime.js';
import { syntheticSource } from './fixtures.js';

test('synthetic artifact replay creates one artifact, observation, and candidate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const repository = new MemoryIngestionRepository();
  const artifacts = new FileArtifactStore(root);
  const runtime = new IngestionRuntime(repository, artifacts);
  const adapter = new SyntheticFixtureAdapter();
  const source = syntheticSource();
  const bytes = new TextEncoder().encode(JSON.stringify({
    items: [{
      id: 'event-1',
      title: '  Saturday Market  ',
      start: '2026-08-15T09:00:00',
      location: '  Lihu\u02bbe  ',
      description: 'Local growers and makers',
      phone: '808-555-0199',
    }],
  }));
  const input = {
    bytes,
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/events.json',
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    source,
    adapter,
    execution: 'fixture' as const,
  };

  const first = await runtime.runArtifact(input);
  assert.equal(first.completeness, 'COMPLETE');
  assert.deepEqual(first.metrics, {
    discovered: 1,
    emitted: 1,
    rejected: 0,
    artifactsCreated: 1,
    observationsCreated: 1,
    candidatesCreated: 1,
    unchanged: false,
  });
  assert.equal(repository.artifacts.size, 1);
  assert.equal(repository.observations.size, 1);
  assert.equal(repository.candidates.size, 1);
  assert.equal(repository.health.get(source.id)?.lastStatus, 'COMPLETE');
  assert.equal(repository.health.get(source.id)?.consecutiveFailures, 0);
  assert.ok(repository.health.get(source.id)?.lastSuccessAt);

  const artifact = [...repository.artifacts.values()][0];
  assert.ok(artifact);
  assert.deepEqual(await artifacts.read(artifact.contentHash), bytes);
  const observation = [...repository.observations.values()][0];
  const candidate = [...repository.candidates.values()][0];
  assert.ok(observation);
  assert.ok(candidate);
  assert.equal('phone' in observation.rawFields, false, 'contact data outside the field allowlist must be dropped');
  assert.equal(candidate.observationId, observation.id);
  assert.equal(candidate.normalizedFields.title, 'Saturday Market');
  assert.equal(candidate.normalizedFields.location, 'Lihu\u02bbe');
  assert.deepEqual(candidate.classificationSuggestion, {
    taxonomyVersion: 'matchbook-topics.v1',
    topicKey: 'food',
    subcategoryKey: 'local_market',
    confidence: 0.78,
    reasons: ['TITLE_MATCH'],
  });
  assert.equal(candidate.recurringSeriesKey, undefined, 'one dated occurrence is not enough recurrence evidence');
  assert.equal(candidate.fingerprint, stableHash({
    sourceId: candidate.sourceId,
    sourceItemKey: candidate.sourceItemKey,
    normalizedFields: candidate.normalizedFields,
  }), 'derived review metadata must not alter the candidate fingerprint');

  for (let replayNumber = 1; replayNumber <= 2; replayNumber += 1) {
    const replay = await runtime.runArtifact(input);
    assert.equal(replay.completeness, 'COMPLETE');
    assert.deepEqual(replay.metrics, {
      discovered: 1,
      emitted: 1,
      rejected: 0,
      artifactsCreated: 0,
      observationsCreated: 0,
      candidatesCreated: 0,
      unchanged: true,
    });
  }
  assert.equal(repository.artifacts.size, 1);
  assert.equal(repository.observations.size, 1);
  assert.equal(repository.candidates.size, 1);
  assert.equal(repository.runs.size, 3, 'each attempt remains auditable even when its payload is unchanged');
  assert.equal(repository.health.get(source.id)?.lastStatus, 'COMPLETE');

  const changedBytes = new TextEncoder().encode(JSON.stringify({
    items: [{
      id: 'event-1',
      title: 'Saturday Market',
      start: '2026-08-15T09:00:00',
      location: 'Kapa\u02bba',
      description: 'Local growers and makers',
    }],
  }));
  const changed = await runtime.runArtifact({ ...input, bytes: changedBytes });
  assert.deepEqual(changed.metrics, {
    discovered: 1,
    emitted: 1,
    rejected: 0,
    artifactsCreated: 1,
    observationsCreated: 1,
    candidatesCreated: 1,
    unchanged: false,
  });
  assert.equal(repository.artifacts.size, 2);
  assert.equal(repository.observations.size, 2);
  assert.equal(repository.candidates.size, 2);
  const candidatesAfterChange = [...repository.candidates.values()];
  const originalCandidate = candidatesAfterChange.find(item => item.normalizedFields.location === 'Lihu\u02bbe');
  const changedCandidate = candidatesAfterChange.find(item => item.normalizedFields.location === 'Kapa\u02bba');
  assert.equal(originalCandidate?.reviewStatus, 'SUPERSEDED');
  assert.equal(changedCandidate?.reviewStatus, 'PENDING');

  assert.ok(changedCandidate);
  const changedCreatedAt = changedCandidate.createdAt;
  const changedObservationId = changedCandidate.observationId;
  const parserUpgradeSource = syntheticSource();
  parserUpgradeSource.parser = { ...parserUpgradeSource.parser, parserVersion: '2.0.0' };
  const parserUpgrade = await runtime.runArtifact({
    ...input,
    bytes: changedBytes,
    source: parserUpgradeSource,
  });
  assert.deepEqual(parserUpgrade.metrics, {
    discovered: 1,
    emitted: 1,
    rejected: 0,
    artifactsCreated: 0,
    observationsCreated: 1,
    candidatesCreated: 0,
    unchanged: false,
  });
  assert.equal(repository.artifacts.size, 2, 'parser changes reuse identical content-addressed bytes');
  assert.equal(repository.observations.size, 3, 'parser-version evidence remains append-only');
  assert.equal(repository.candidates.size, 2, 'unchanged normalized facts keep one logical candidate');
  const refreshedCandidate = repository.candidates.get(changedCandidate.fingerprint);
  assert.equal(refreshedCandidate?.createdAt, changedCreatedAt, 'candidate creation time is historical');
  assert.notEqual(refreshedCandidate?.observationId, changedObservationId, 'candidate points at the newest parser evidence');
  assert.equal(refreshedCandidate?.reviewStatus, 'PENDING');
});

test('runtime persists run-level series suggestions without duplicate revision churn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const source = syntheticSource();
  const runtime = new IngestionRuntime(repository, new FileArtifactStore(root));
  const input = {
    bytes: new TextEncoder().encode(JSON.stringify({
      items: [
        { id: 'yoga-1', title: 'Morning Yoga', start: '2026-08-11T08:00:00-10:00', location: 'Main Hall' },
        { id: 'yoga-2', title: 'Morning Yoga', start: '2026-08-18T08:00:00-10:00', location: 'Main Hall' },
        { id: 'concert-1', title: 'One Night Concert', start: '2026-08-20T19:00:00-10:00', location: 'Main Hall' },
      ],
    })),
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/events.json',
    statusCode: 200,
    responseHeaders: { 'content-type': 'application/json' },
    source,
    adapter: new SyntheticFixtureAdapter(),
    execution: 'fixture' as const,
  };

  const first = await runtime.runArtifact(input);
  assert.equal(first.metrics.candidatesCreated, 3);
  const yoga = [...repository.candidates.values()]
    .filter(candidate => candidate.sourceItemKey.startsWith('yoga-'));
  assert.equal(yoga.length, 2);
  assert.match(yoga[0]?.recurringSeriesKey ?? '', /^series:v1:[a-f0-9]{64}$/);
  assert.equal(yoga[0]?.recurringSeriesKey, yoga[1]?.recurringSeriesKey);
  assert.ok(yoga.every(candidate => (
    candidate.classificationSuggestion?.topicKey === 'wellness'
      && candidate.classificationSuggestion.subcategoryKey === 'yoga_meditation'
  )));
  const concert = [...repository.candidates.values()]
    .find(candidate => candidate.sourceItemKey === 'concert-1');
  assert.ok(concert);
  assert.equal(concert.recurringSeriesKey, undefined);

  const approved = yoga[0];
  assert.ok(approved);
  approved.reviewStatus = 'APPROVED';
  const replay = await runtime.runArtifact(input);
  assert.equal(replay.metrics.candidatesCreated, 0);
  assert.equal(repository.candidates.size, 3);
  assert.equal(approved.reviewStatus, 'APPROVED');
});

test('automatic execution refuses a disabled or unapproved source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const runtime = new IngestionRuntime(new MemoryIngestionRepository(), new FileArtifactStore(root));

  await assert.rejects(
    runtime.runArtifact({
      bytes: new TextEncoder().encode('{"items":[]}'),
      mediaType: 'application/json',
      sourceUrl: 'https://fixture.example/events.json',
      statusCode: 200,
      responseHeaders: {},
      source: syntheticSource(),
      adapter: new SyntheticFixtureAdapter(),
      execution: 'automatic',
    }),
    /not approved for automatic collection/,
  );
});

test('practice execution is limited to PROBE_REQUIRED sources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const runtime = new IngestionRuntime(repository, new FileArtifactStore(root));
  const source = syntheticSource();
  source.adapterKind = 'SYNTHETIC_FIXTURE';

  await assert.rejects(runtime.runArtifact({
    bytes: new TextEncoder().encode('{"items":[]}'),
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/events.json',
    statusCode: 200,
    responseHeaders: {},
    source: { ...source, permission: 'MANUAL_ONLY' },
    adapter: new SyntheticFixtureAdapter(),
    execution: 'practice',
  }), /not awaiting a practice probe/);
});

test('identical replay preserves an approved candidate decision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const runtime = new IngestionRuntime(repository, new FileArtifactStore(root));
  const source = syntheticSource();
  const input = {
    bytes: new TextEncoder().encode(JSON.stringify({
      items: [{ id: 'approved-event', title: 'Approved event', start: '2026-08-15T09:00:00' }],
    })),
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/events.json',
    statusCode: 200,
    responseHeaders: {},
    source,
    adapter: new SyntheticFixtureAdapter(),
    execution: 'fixture' as const,
  };
  await runtime.runArtifact(input);
  const candidate = [...repository.candidates.values()][0];
  assert.ok(candidate);
  candidate.reviewStatus = 'APPROVED';
  await runtime.runArtifact(input);
  assert.equal(candidate.reviewStatus, 'APPROVED');
});

test('failed and partial runs update aggregate source health without payload data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'matchbook-ingestion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repository = new MemoryIngestionRepository();
  const runtime = new IngestionRuntime(repository, new FileArtifactStore(root));
  const source = syntheticSource();
  const adapter = new SyntheticFixtureAdapter();

  await assert.rejects(runtime.runArtifact({
    bytes: new TextEncoder().encode('{not-json'),
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/events.json',
    statusCode: 200,
    responseHeaders: { 'set-cookie': 'must-not-be-recorded' },
    source,
    adapter,
    execution: 'fixture',
  }));
  const failed = repository.health.get(source.id);
  assert.equal(failed?.lastStatus, 'FAILED');
  assert.equal(failed?.lastErrorCode, 'INGESTION_FAILED');
  assert.equal(failed?.consecutiveFailures, 1);
  assert.deepEqual(Object.keys(failed ?? {}).sort(), [
    'consecutiveFailures',
    'lastAttemptAt',
    'lastErrorCode',
    'lastStatus',
    'sourceId',
  ]);
  assert.deepEqual(
    [...repository.artifacts.values()][0]?.responseHeaders,
    {},
    'runtime must not persist Set-Cookie even when an artifact is injected directly',
  );

  const partialAdapter = new SyntheticFixtureAdapter();
  partialAdapter.extract = async () => ({
    items: [],
    completeness: 'PARTIAL',
    warnings: [{ code: 'FIXTURE_PARTIAL', message: 'one page was unavailable' }],
    metrics: { discovered: 0, emitted: 0, rejected: 0 },
  });
  const partial = await runtime.runArtifact({
    bytes: new TextEncoder().encode('{"items":[]}'),
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/partial.json',
    statusCode: 200,
    responseHeaders: {},
    source,
    adapter: partialAdapter,
    execution: 'fixture',
  });
  assert.equal(partial.completeness, 'PARTIAL');
  assert.equal(repository.health.get(source.id)?.lastStatus, 'PARTIAL');
  assert.equal(repository.health.get(source.id)?.lastErrorCode, 'PARTIAL_RUN');
  assert.equal(repository.health.get(source.id)?.consecutiveFailures, 2);

  const partialReplay = await runtime.runArtifact({
    bytes: new TextEncoder().encode('{"items":[]}'),
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/partial.json',
    statusCode: 200,
    responseHeaders: {},
    source,
    adapter: partialAdapter,
    execution: 'fixture',
  });
  assert.equal(partialReplay.completeness, 'PARTIAL', 'an unchanged partial artifact must not heal itself');
  assert.equal(partialReplay.metrics.unchanged, true);
  assert.equal(repository.health.get(source.id)?.lastStatus, 'PARTIAL');

  await runtime.runArtifact({
    bytes: new TextEncoder().encode('{"items":[{"id":"recovered","title":"Recovered","start":"2026-08-09T10:00:00"}]}'),
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/recovered.json',
    statusCode: 200,
    responseHeaders: {},
    source,
    adapter,
    execution: 'fixture',
  });
  const recovered = repository.health.get(source.id);
  assert.equal(recovered?.lastStatus, 'COMPLETE');
  assert.equal(recovered?.consecutiveFailures, 0);
  assert.equal(recovered?.lastErrorCode, undefined);
  assert.ok(recovered?.lastSuccessAt);
});
