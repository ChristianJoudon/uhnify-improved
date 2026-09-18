import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { ManualSupportAdapter } from './adapters/manual-support.js';
import { FileArtifactStore } from './artifact-store.js';
import { MongoIngestionRepository } from './repository.js';
import { IngestionRuntime } from './runtime.js';
import { loadSourceRegistry } from './source-registry.js';
import { executeSource } from './source-execution.js';
import { runWorker } from './worker.js';

const command = process.argv[2];

if (command === 'validate-registry') {
  const registry = await loadSourceRegistry();
  const enabled = registry.sources.filter(source => source.enabled).length;
  process.stdout.write(`${JSON.stringify({
    registryVersion: registry.registryVersion,
    sources: registry.sources.length,
    enabled,
    probeRequired: registry.sources.filter(source => source.permission === 'PROBE_REQUIRED').length,
    manualOnly: registry.sources.filter(source => source.permission === 'MANUAL_ONLY').length,
  }, null, 2)}\n`);
} else if (command === 'ingest-support-snapshots') {
  if (!process.argv.includes('--confirm-sensitive-manual')) {
    throw new Error('Support ingestion requires --confirm-sensitive-manual');
  }
  const mongoUrl = process.env.MONGO_URL;
  if (!mongoUrl) throw new Error('MONGO_URL is required; no database default is assumed');

  const registry = await loadSourceRegistry();
  const selectedIds = process.argv.slice(3).filter(argument => !argument.startsWith('--'));
  const sourceIds = selectedIds.length
    ? selectedIds
    : registry.sources.filter(source => /^SEN-\d{3}$/.test(source.id)).map(source => source.id);
  const client = new MongoClient(mongoUrl);
  await client.connect();
  try {
    const repository = new MongoIngestionRepository(client);
    const artifactRoot = process.env.MATCHBOOK_ARTIFACT_ROOT
      ?? fileURLToPath(new URL('../.artifacts/support', import.meta.url));
    const runtime = new IngestionRuntime(repository, new FileArtifactStore(artifactRoot));
    const adapter = new ManualSupportAdapter();
    const results = [];

    for (const sourceId of sourceIds) {
      const source = registry.sources.find(candidate => candidate.id === sourceId);
      if (!source || source.adapterKind !== 'MANUAL_CLIP' || source.permission !== 'MANUAL_ONLY') {
        throw new Error(`${sourceId} is not a registered MANUAL_ONLY support source`);
      }
      const bytes = new Uint8Array(await readFile(new URL(`../fixtures/support/${sourceId}.json`, import.meta.url)));
      await repository.upsertSource(source, registry.registryVersion);
      const result = await runtime.runArtifact({
        bytes,
        mediaType: 'application/json',
        sourceUrl: source.publisherUrl,
        statusCode: 200,
        responseHeaders: { 'content-type': 'application/json' },
        source,
        adapter,
        execution: 'manual',
      });
      results.push({ sourceId, ...result });
    }
    process.stdout.write(`${JSON.stringify({
      registryVersion: registry.registryVersion,
      sources: results.length,
      results,
    }, null, 2)}\n`);
  } finally {
    await client.close();
  }
} else if (command === 'run-source') {
  const sourceId = process.argv.slice(3).find(argument => !argument.startsWith('--'));
  if (!sourceId) throw new Error('run-source requires a governed source id');
  const mongoUrl = process.env.MONGO_URL;
  if (!mongoUrl) throw new Error('MONGO_URL is required; no database default is assumed');
  const registry = await loadSourceRegistry();
  const source = registry.sources.find(candidate => candidate.id === sourceId);
  if (!source) throw new Error(`Unknown governed source ${sourceId}`);
  if (source.adapterKind === 'MANUAL_CLIP' && !process.argv.includes('--confirm-sensitive-manual')) {
    throw new Error('Support ingestion requires --confirm-sensitive-manual');
  }
  if (source.permission === 'PROBE_REQUIRED' && !process.argv.includes('--practice')) {
    throw new Error('A PROBE_REQUIRED source may only run with --practice');
  }
  const client = new MongoClient(mongoUrl);
  await client.connect();
  try {
    const result = await executeSource({
      source,
      registry,
      repository: new MongoIngestionRepository(client),
      ...(process.env.MATCHBOOK_ARTIFACT_ROOT ? { artifactRoot: process.env.MATCHBOOK_ARTIFACT_ROOT } : {}),
      ...(process.env.MATCHBOOK_INGESTION_USER_AGENT ? { userAgent: process.env.MATCHBOOK_INGESTION_USER_AGENT } : {}),
    });
    process.stdout.write(`${JSON.stringify({ sourceId, ...result }, null, 2)}\n`);
  } finally {
    await client.close();
  }
} else if (command === 'worker') {
  const mongoUrl = process.env.MONGO_URL;
  if (!mongoUrl) throw new Error('MONGO_URL is required; no database default is assumed');
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const result = await runWorker({
    mongoUrl,
    once: process.argv.includes('--once'),
    drain: process.argv.includes('--drain'),
    signal: controller.signal,
    ...(process.env.MATCHBOOK_ARTIFACT_ROOT ? { artifactRoot: process.env.MATCHBOOK_ARTIFACT_ROOT } : {}),
    ...(process.env.MATCHBOOK_INGESTION_USER_AGENT ? { userAgent: process.env.MATCHBOOK_INGESTION_USER_AGENT } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  process.stderr.write(
    'usage: tsx src/cli.ts validate-registry | ingest-support-snapshots --confirm-sensitive-manual [SEN-### ...] | run-source [--practice|--confirm-sensitive-manual] SOURCE_ID | worker [--once]\n',
  );
  process.exitCode = 1;
}
