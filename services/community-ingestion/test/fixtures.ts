import type { SourceDefinition } from '../src/contracts.js';

export function syntheticSource(): SourceDefinition {
  return {
    id: 'source-synthetic-fixture',
    slug: 'synthetic-fixture',
    displayName: 'Synthetic Fixture',
    publisherName: 'MatchBook Tests',
    publisherUrl: 'https://fixture.example/about',
    tier: 'X',
    adapterKind: 'SYNTHETIC_FIXTURE',
    adapterConfig: { kind: 'SYNTHETIC_FIXTURE' },
    endpoints: [{
      purpose: 'COLLECTION',
      method: 'GET',
      urlTemplate: 'https://fixture.example/events.json',
    }],
    trust: 'PARTNER',
    permission: 'PROBE_REQUIRED',
    contentKinds: ['event'],
    polling: {
      intervalMinutes: 60,
      jitterPercent: 0,
      lookBackDays: 1,
      lookAheadDays: 30,
      maxPages: 1,
      maxItems: 100,
    },
    httpPolicy: {
      allowedHosts: ['fixture.example'],
      allowedRedirectHosts: [],
      allowedMediaTypes: ['application/json'],
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      maxRedirects: 1,
      minimumDelayMs: 0,
    },
    parser: {
      parserId: 'synthetic-fixture',
      parserVersion: '1.0.0',
      fixtureVersion: '1',
    },
    fieldAllowlist: ['id', 'title', 'start', 'location', 'description'],
    authorityByField: {
      title: 'PARTNER',
      start: 'PARTNER',
      location: 'PARTNER',
    },
    enabled: false,
    nextRunAt: '2026-08-08T12:00:00.000Z',
    lastVerifiedAt: '2026-08-08T12:00:00.000Z',
    steward: 'test-suite',
  };
}
