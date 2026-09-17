import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRegistry } from '../src/contracts.js';
import { syntheticSource } from './fixtures.js';

test('registry accepts a valid, disabled probe source', () => {
  const registry = validateRegistry({
    registryVersion: 'test.v1',
    sources: [syntheticSource()],
  });

  assert.equal(registry.sources.length, 1);
  assert.equal(registry.sources[0]?.id, 'source-synthetic-fixture');
});

test('registry rejects duplicate source ids and slugs', () => {
  const source = syntheticSource();
  assert.throws(
    () => validateRegistry({ registryVersion: 'test.v1', sources: [source, { ...source }] }),
    /Duplicate source id/,
  );

  assert.throws(
    () => validateRegistry({
      registryVersion: 'test.v1',
      sources: [source, { ...source, id: 'source-second' }],
    }),
    /Duplicate source slug/,
  );
});

test('registry prevents collection unless permission and endpoint policy agree', () => {
  assert.throws(
    () => validateRegistry({
      registryVersion: 'test.v1',
      sources: [{ ...syntheticSource(), enabled: true }],
    }),
    /Only an AUTOMATED_ALLOWED source may be enabled/,
  );

  const source = syntheticSource();
  source.endpoints = [{
    purpose: 'COLLECTION',
    method: 'GET',
    urlTemplate: 'https://unapproved.example/events.json',
  }];
  assert.throws(
    () => validateRegistry({ registryVersion: 'test.v1', sources: [source] }),
    /Endpoint host unapproved\.example is not allowlisted/,
  );
});

test('registry requires adapter configuration to match its declared adapter', () => {
  const source = syntheticSource();
  const mismatched = {
    ...source,
    adapterKind: 'STATIC_JSON',
  };
  assert.throws(
    () => validateRegistry({ registryVersion: 'test.v1', sources: [mismatched] }),
    /adapterConfig\.kind must match adapterKind/,
  );
});

test('registry rejects credentials and secret query parameters in endpoint URLs', () => {
  const credentialed = syntheticSource();
  credentialed.endpoints = [{
    purpose: 'COLLECTION',
    method: 'GET',
    urlTemplate: 'https://crawler:password@fixture.example/events.json',
  }];
  assert.throws(
    () => validateRegistry({ registryVersion: 'test.v1', sources: [credentialed] }),
    /Endpoint URLs must not contain credentials/,
  );

  for (const name of ['token', 'key', 'API_KEY', 'access_token', 'password', 'secret']) {
    const source = syntheticSource();
    source.endpoints = [{
      purpose: 'COLLECTION',
      method: 'GET',
      urlTemplate: `https://fixture.example/events.json?${name}=do-not-store`,
    }];
    assert.throws(
      () => validateRegistry({ registryVersion: 'test.v1', sources: [source] }),
      /Endpoint URLs must not contain secret query parameter/,
      name,
    );
  }
});

test('registry rejects secret-bearing endpoint headers case-insensitively', () => {
  for (const name of ['Authorization', 'cookie', 'PROXY-AUTHORIZATION', 'X-API-Key']) {
    const source = syntheticSource();
    source.endpoints = [{
      purpose: 'COLLECTION',
      method: 'GET',
      urlTemplate: 'https://fixture.example/events.json',
      headers: { [name]: 'do-not-store' },
    }];
    assert.throws(
      () => validateRegistry({ registryVersion: 'test.v1', sources: [source] }),
      /Endpoint headers must not contain secret header/,
      name,
    );
  }
});
