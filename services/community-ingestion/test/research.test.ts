import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtractedItem, SourceDefinition } from '../src/contracts.js';
import {
  BraveResearchSearchProvider,
  candidateResearchBasisFor,
  researchSearchProviderFromEnvironment,
  runCandidateResearch,
  type CandidateForResearch,
  type ResearchExtractResult,
} from '../src/research.js';
import { researchEffectiveNormalizedFields } from '../src/research-repository.js';
import { syntheticSource } from './fixtures.js';

const source = (): SourceDefinition => {
  const value = syntheticSource();
  return {
    ...value,
    id: 'SRC-901',
    adapterKind: 'STATIC_JSON',
    adapterConfig: { kind: 'STATIC_JSON', eventSelector: '$.*' },
    publisherName: 'Fixture Community Calendar',
  };
};

const candidate = (overrides: Partial<CandidateForResearch> = {}): CandidateForResearch => ({
  id: 'candidate-1',
  sourceId: 'SRC-901',
  sourceItemKey: 'event-1',
  fingerprint: 'fingerprint-1',
  observationId: 'observation-1',
  editorialRevision: 0,
  entityHint: 'event',
  normalizedFields: {
    title: 'Community cleanup',
    localStart: '2026-08-15T08:30:00-10:00',
    timeZone: 'Pacific/Honolulu',
    sourceUrl: 'https://fixture.example/events/cleanup',
  },
  detailUrl: 'https://fixture.example/events/cleanup',
  ...overrides,
});

const item = (normalizedFields: Record<string, unknown>): ExtractedItem => ({
  sourceItemKey: 'event-1',
  canonicalSourceUrl: 'https://fixture.example/events/cleanup',
  entityHint: 'event',
  rawFields: { id: 'event-1' },
  normalizedFields: {
    title: 'Community cleanup',
    localStart: '2026-08-15T08:30:00-10:00',
    timeZone: 'Pacific/Honolulu',
    sourceUrl: 'https://fixture.example/events/cleanup',
    ...normalizedFields,
  },
  evidence: [],
});

const extraction = (normalizedFields: Record<string, unknown>, suffix = 'retained'): ResearchExtractResult => ({
  items: [item(normalizedFields)],
  evidenceUrl: 'https://fixture.example/events/cleanup',
  contentHash: `content-${suffix}`,
});

const fixedNow = () => new Date('2026-08-09T12:00:00.000Z');
const attemptSummary = (attempts: Array<{ strategy: string; status: string; code?: string }>) => (
  attempts.map(({ strategy, status, code }) => ({ strategy, status, ...(code ? { code } : {}) }))
);

test('retained evidence is inspected first and avoids every network fallback when useful', async () => {
  const calls: string[] = [];
  const result = await runCandidateResearch({
    requestId: 'request-1',
    candidate: candidate(),
    source: source(),
    retainedEvidence: async () => {
      calls.push('retained');
      return extraction({
        description: 'Bring gloves and water.',
        location: 'Lydgate Beach Park, 4470 Nalu Rd, Kapaʻa, HI 96746',
      });
    },
    officialDetail: async () => {
      calls.push('official');
      return extraction({ description: 'wrong fallback' });
    },
    registeredSourceRefetch: async () => {
      calls.push('registered');
      return extraction({ description: 'wrong fallback' });
    },
    searchProvider: {
      name: 'TEST',
      async search() {
        calls.push('search');
        return [];
      },
    },
    now: fixedNow,
  });

  assert.deepEqual(calls, ['retained']);
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(attemptSummary(result.attempts), [{ strategy: 'RETAINED_EVIDENCE', status: 'SUCCEEDED' }]);
  assert.deepEqual(result.fieldSuggestions.map(value => value.field), ['location']);
  assert.equal(JSON.stringify(result).includes('Bring gloves and water.'), false);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.basisKey, result.basis.basisKey);
  assert.equal(result.fieldSuggestions[0]?.basisKey, result.basis.basisKey);
  assert.equal('rawFields' in result, false);
});

test('an impossible source end time stays unresolved until a valid corrected end is found', async () => {
  const result = await runCandidateResearch({
    requestId: 'request-invalid-end',
    candidate: candidate({
      normalizedFields: {
        title: 'Math prep week',
        location: 'Kauaʻi Community College, 3-1901 Kaumualiʻi Highway, Līhuʻe, HI 96766',
        localStart: '2026-08-15T09:00:00-10:00',
        localEnd: '2026-08-15T08:00:00-10:00',
        timeZone: 'Pacific/Honolulu',
      },
    }),
    source: source(),
    retainedEvidence: async () => extraction({
      localEnd: '2026-08-15T12:00:00-10:00',
    }),
    now: fixedNow,
  });

  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.fieldSuggestions.map(value => [value.field, value.value]), [
    ['localEnd', '2026-08-15T12:00:00-10:00'],
  ]);
});

test('fallback order is official detail, registered refetch, then configured search', async () => {
  const calls: string[] = [];
  const result = await runCandidateResearch({
    requestId: 'request-2',
    candidate: candidate(),
    source: source(),
    retainedEvidence: async () => {
      calls.push('retained');
      return { ...extraction({}, 'retained'), items: [] };
    },
    officialDetail: async url => {
      calls.push(`official:${url}`);
      return { ...extraction({}, 'official'), items: [] };
    },
    registeredSourceRefetch: async () => {
      calls.push('registered');
      return { ...extraction({}, 'registered'), items: [] };
    },
    searchProvider: {
      name: 'TEST_SEARCH',
      async search(query) {
        calls.push(`search:${query}`);
        return [{ url: 'https://fixture.example/events/cleanup-details' }];
      },
    },
    now: fixedNow,
  });

  assert.deepEqual(calls.map(value => value.split(':')[0]), [
    'retained', 'official', 'registered', 'search',
  ]);
  assert.deepEqual(result.attempts.map(value => value.strategy), [
    'RETAINED_EVIDENCE',
    'OFFICIAL_DETAIL',
    'REGISTERED_SOURCE_REFETCH',
    'WEB_SEARCH_PROVIDER',
  ]);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.fieldSuggestions.length, 0, 'search leads never become automatic field values');
  assert.equal(result.evidence[0]?.sourceUrl, 'https://fixture.example/events/cleanup-details');
  assert.equal(result.searchFallback.availability, 'AVAILABLE');
  assert.equal(result.searchFallback.provider, 'TEST_SEARCH');
});

test('an absent API provider exposes an available manual public-facts search link without pretending it ran', async () => {
  const result = await runCandidateResearch({
    requestId: 'request-3',
    candidate: candidate(),
    source: source(),
    retainedEvidence: async () => ({ ...extraction({}), items: [] }),
    officialDetail: async () => ({ ...extraction({}), items: [] }),
    registeredSourceRefetch: async () => ({ ...extraction({}), items: [] }),
    now: fixedNow,
  });

  assert.equal(result.status, 'UNAVAILABLE');
  assert.deepEqual(attemptSummary(result.attempts).at(-1), {
    strategy: 'WEB_SEARCH_PROVIDER',
    status: 'UNAVAILABLE',
    code: 'SEARCH_PROVIDER_NOT_CONFIGURED',
  });
  assert.equal(result.searchFallback.availability, 'AVAILABLE');
  assert.match(result.searchFallback.href, /^https:\/\/search\.brave\.com\/search\?q=/);
  assert.match(result.searchFallback.query, /Community cleanup/);
  assert.equal(result.searchFallback.provider, undefined);
  assert.deepEqual(result.missingFields, ['location']);
  assert.equal(result.retryable, true);
});

test('description-only retained evidence does not stop official location and schedule research', async () => {
  const calls: string[] = [];
  const result = await runCandidateResearch({
    requestId: 'request-required-fields',
    candidate: candidate({
      normalizedFields: {
        title: 'Community cleanup',
        sourceUrl: 'https://fixture.example/events/cleanup',
      },
    }),
    source: source(),
    retainedEvidence: async () => {
      calls.push('retained');
      return extraction({
        description: 'Optional source description.',
        localStart: undefined,
      }, 'retained-description');
    },
    officialDetail: async () => {
      calls.push('official');
      return extraction({
        location: 'Lydgate Beach Park, 4470 Nalu Rd, Kapaʻa, HI 96746',
        localStart: '2026-08-15T08:30:00-10:00',
        localEnd: '2026-08-15T10:00:00-10:00',
      }, 'official-required');
    },
    registeredSourceRefetch: async () => {
      calls.push('registered');
      return extraction({ location: 'Wrong later location' });
    },
    now: fixedNow,
  });

  assert.deepEqual(calls, ['retained', 'official']);
  assert.deepEqual(attemptSummary(result.attempts), [
    { strategy: 'RETAINED_EVIDENCE', status: 'NO_MATCH', code: 'NO_NEW_SAFE_FIELDS' },
    { strategy: 'OFFICIAL_DETAIL', status: 'SUCCEEDED' },
  ]);
  assert.deepEqual(result.fieldSuggestions.map(value => value.field), [
    'location', 'localStart', 'localEnd',
  ]);
  assert.equal(JSON.stringify(result).includes('Optional source description.'), false);
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.status, 'SUCCEEDED');
});

test('a named venue clue triggers a governed address follow-up and targeted manual fallback', async () => {
  const calls: string[] = [];
  const progress: string[] = [];
  const result = await runCandidateResearch({
    requestId: 'request-venue-address',
    candidate: candidate({
      normalizedFields: {
        title: 'Community cleanup',
        location: 'St. Raphael Church',
        localStart: '2026-08-15T08:30:00-10:00',
        sourceUrl: 'https://fixture.example/events/cleanup',
      },
    }),
    source: source(),
    retainedEvidence: async () => {
      calls.push('retained');
      return extraction({ location: 'St. Raphael Church' }, 'retained-venue-clue');
    },
    officialDetail: async () => {
      calls.push('official');
      return extraction({
        location: 'St. Raphael Church, 3011 Hapa Rd, Kōloa, HI 96756',
      }, 'official-address');
    },
    onProgress: update => {
      progress.push(`${update.stage}:${update.status}`);
    },
    now: fixedNow,
  });

  assert.deepEqual(calls, ['retained', 'official']);
  assert.deepEqual(result.fieldSuggestions.map(value => [value.field, value.value]), [[
    'location', 'St. Raphael Church, 3011 Hapa Rd, Kōloa, HI 96756',
  ]]);
  assert.deepEqual(result.missingFields, []);
  assert.match(result.searchFallback.query, /St\. Raphael Church street address/);
  assert.deepEqual(progress, [
    'RETAINED_EVIDENCE:RUNNING',
    'RETAINED_EVIDENCE:COMPLETED',
    'OFFICIAL_DETAIL:RUNNING',
    'OFFICIAL_DETAIL:COMPLETED',
    'COMPLETE:COMPLETED',
  ]);
});

test('research can suggest a missing editable title', async () => {
  const result = await runCandidateResearch({
    requestId: 'request-missing-title',
    candidate: candidate({
      normalizedFields: {
        location: 'Lydgate Beach Park, 4470 Nalu Rd, Kapaʻa, HI 96746',
        localStart: '2026-08-15T08:30:00-10:00',
        sourceUrl: 'https://fixture.example/events/cleanup',
      },
    }),
    source: source(),
    retainedEvidence: async () => extraction({ title: 'Community cleanup' }, 'retained-title'),
    now: fixedNow,
  });

  assert.deepEqual(result.fieldSuggestions.map(value => [value.field, value.value]), [
    ['title', 'Community cleanup'],
  ]);
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.status, 'SUCCEEDED');
});

test('group label arrays become editable scalar location and recurrence suggestions', async () => {
  const groupCandidate = candidate({
    entityHint: 'group',
    sourceItemKey: 'group-1',
    normalizedFields: { title: 'Community support group' },
  });
  const groupItem: ExtractedItem = {
    sourceItemKey: 'group-1',
    canonicalSourceUrl: 'https://fixture.example/groups/support',
    entityHint: 'group',
    rawFields: {},
    normalizedFields: {
      title: 'Community support group',
      locationLabels: ['Lihuʻe community room'],
      recurrenceLabels: ['Every Tuesday at 6:00 PM'],
    },
    evidence: [],
  };
  const result = await runCandidateResearch({
    requestId: 'request-group-labels',
    candidate: groupCandidate,
    source: source(),
    retainedEvidence: async () => ({
      items: [groupItem],
      evidenceUrl: 'https://fixture.example/groups/support',
      contentHash: 'group-content',
    }),
    now: fixedNow,
  });

  assert.deepEqual(Object.fromEntries(result.fieldSuggestions.map(value => [value.field, value.value])), {
    location: 'Lihuʻe community room',
    recurrenceLabel: 'Every Tuesday at 6:00 PM',
  });
  assert.deepEqual(result.missingFields, []);
});

test('group research ignores one-time dates and continues until it finds a recurrence label', async () => {
  const calls: string[] = [];
  const groupCandidate = candidate({
    entityHint: 'group',
    sourceItemKey: 'group-1',
    normalizedFields: {
      title: 'Community support group',
      location: 'Lihuʻe community room',
      localStart: '2026-08-15T18:00:00-10:00',
    },
  });
  const groupResult = (
    normalizedFields: Record<string, unknown>,
    suffix: string,
  ): ResearchExtractResult => ({
    items: [{
      sourceItemKey: 'group-1',
      canonicalSourceUrl: 'https://fixture.example/groups/support',
      entityHint: 'group',
      rawFields: {},
      normalizedFields: {
        title: 'Community support group',
        location: 'Lihuʻe community room',
        ...normalizedFields,
      },
      evidence: [],
    }],
    evidenceUrl: 'https://fixture.example/groups/support',
    contentHash: `group-${suffix}`,
  });
  const result = await runCandidateResearch({
    requestId: 'request-group-recurrence-only',
    candidate: groupCandidate,
    source: source(),
    retainedEvidence: async () => {
      calls.push('retained');
      return groupResult({
        localStart: '2026-08-15T18:00:00-10:00',
        localEnd: '2026-08-15T19:00:00-10:00',
      }, 'retained-one-time');
    },
    officialDetail: async () => {
      calls.push('official');
      return groupResult({
        localStart: '2026-08-15T18:00:00-10:00',
        recurrenceLabel: 'Every Tuesday at 6:00 PM',
      }, 'official-recurrence');
    },
    now: fixedNow,
  });

  assert.deepEqual(calls, ['retained', 'official']);
  assert.deepEqual(attemptSummary(result.attempts), [
    { strategy: 'RETAINED_EVIDENCE', status: 'NO_MATCH', code: 'NO_NEW_SAFE_FIELDS' },
    { strategy: 'OFFICIAL_DETAIL', status: 'SUCCEEDED' },
  ]);
  assert.deepEqual(result.fieldSuggestions.map(value => [value.field, value.value]), [
    ['recurrenceLabel', 'Every Tuesday at 6:00 PM'],
  ]);
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.status, 'SUCCEEDED');
});

test('later fallbacks fill gaps without overwriting earlier higher-confidence suggestions', async () => {
  const result = await runCandidateResearch({
    requestId: 'request-no-conflict',
    candidate: candidate({
      normalizedFields: { sourceUrl: 'https://fixture.example/events/cleanup' },
    }),
    source: source(),
    retainedEvidence: async () => extraction({
      title: 'Retained title',
      localStart: undefined,
    }, 'retained-title'),
    officialDetail: async () => extraction({
      title: 'Conflicting official title',
      location: 'Official park, 123 Main Rd, Kapaʻa, HI 96746',
      localStart: undefined,
    }, 'official-location'),
    registeredSourceRefetch: async () => extraction({
      title: 'Conflicting registered title',
      location: 'Conflicting registered park',
      localStart: '2026-08-15T08:30:00-10:00',
    }, 'registered-schedule'),
    now: fixedNow,
  });

  assert.deepEqual(Object.fromEntries(result.fieldSuggestions.map(value => [value.field, value.value])), {
    title: 'Retained title',
    location: 'Official park, 123 Main Rd, Kapaʻa, HI 96746',
    localStart: '2026-08-15T08:30:00-10:00',
  });
  assert.equal(result.fieldSuggestions.filter(value => value.field === 'title').length, 1);
  assert.equal(result.fieldSuggestions.filter(value => value.field === 'location').length, 1);
  assert.deepEqual(result.attempts.map(value => value.strategy), [
    'RETAINED_EVIDENCE', 'OFFICIAL_DETAIL', 'REGISTERED_SOURCE_REFETCH',
  ]);
  assert.deepEqual(result.missingFields, []);
});

test('sensitive sources inspect retained evidence but never fetch or broad-search', async () => {
  const calls: string[] = [];
  const sensitiveSource: SourceDefinition = {
    ...source(),
    id: 'SEN-901',
    adapterKind: 'MANUAL_CLIP',
    adapterConfig: { kind: 'MANUAL_CLIP' },
    permission: 'MANUAL_ONLY',
  };
  const result = await runCandidateResearch({
    requestId: 'request-sensitive',
    candidate: candidate({
      sourceId: 'SEN-901',
      reviewLane: 'SENSITIVE',
      privacyReviewRequired: true,
      normalizedFields: {
        title: 'Private recovery meeting title',
        recurrenceLabel: 'Weekly',
        sourceUrl: 'https://fixture.example/support',
      },
    }),
    source: sensitiveSource,
    retainedEvidence: async () => {
      calls.push('retained');
      return { ...extraction({}), items: [] };
    },
    officialDetail: async () => {
      calls.push('official');
      return extraction({});
    },
    registeredSourceRefetch: async () => {
      calls.push('registered');
      return extraction({});
    },
    searchProvider: {
      name: 'TEST',
      async search() {
        calls.push('search');
        return [];
      },
    },
    now: fixedNow,
  });

  assert.deepEqual(calls, ['retained']);
  assert.deepEqual(result.attempts.map(value => [value.strategy, value.status]), [
    ['RETAINED_EVIDENCE', 'NO_MATCH'],
    ['OFFICIAL_DETAIL', 'UNAVAILABLE'],
    ['REGISTERED_SOURCE_REFETCH', 'UNAVAILABLE'],
    ['WEB_SEARCH_PROVIDER', 'UNAVAILABLE'],
  ]);
  assert.doesNotMatch(result.searchFallback.query, /Private recovery meeting title/);
  assert.equal(result.searchFallback.availability, 'UNAVAILABLE');
  assert.equal(result.searchFallback.provider, undefined);
});

test('hostile extracted text, contact data, meeting links, and redirect results are never persisted', async () => {
  const result = await runCandidateResearch({
    requestId: 'request-hostile',
    candidate: candidate(),
    source: source(),
    retainedEvidence: async () => extraction({
      description: '<script>steal()</script> Contact person@example.com',
      location: 'Call 808-555-1212 for the location',
      localEnd: '2026-08-15T10:00:00-10:00',
    }),
    searchProvider: {
      name: 'TEST',
      async search() {
        return [
          { url: 'https://zoom.us/j/123456789?pwd=secret' },
          { url: 'https://www.google.com/url?q=https://fixture.example/event' },
          { url: 'https://fixture.example/events/safe' },
        ];
      },
    },
    now: fixedNow,
  });

  assert.deepEqual(result.fieldSuggestions.map(value => value.field), ['localEnd']);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /person@example\.com|808-555-1212|steal\(\)|zoom\.us|google\.com\/url/);
});

test('search result safety drops meeting and redirect URLs without storing snippets', async () => {
  const result = await runCandidateResearch({
    requestId: 'request-search-safety',
    candidate: candidate(),
    source: source(),
    retainedEvidence: async () => ({ ...extraction({}), items: [] }),
    officialDetail: async () => ({ ...extraction({}), items: [] }),
    registeredSourceRefetch: async () => ({ ...extraction({}), items: [] }),
    searchProvider: {
      name: 'TEST',
      async search() {
        return [
          { url: 'https://zoom.us/j/123456789' },
          { url: 'https://t.co/redirect' },
          { url: 'https://fixture.example/contact/person%40example.com' },
          { url: 'https://fixture.example/events/safe' },
        ];
      },
    },
    now: fixedNow,
  });

  assert.deepEqual(result.evidence.map(value => value.sourceUrl), ['https://fixture.example/events/safe']);
  assert.deepEqual(result.evidence[0]?.fields, []);
  assert.equal(JSON.stringify(result).includes('snippet'), false);
});

test('basis cache key is stable for a review revision and changes on editorial revision', () => {
  const base = candidateResearchBasisFor(candidate());
  const same = candidateResearchBasisFor(candidate({ observationId: 'a-new-observation' }));
  const edited = candidateResearchBasisFor(candidate({ editorialRevision: 1 }));
  assert.equal(base.basisKey, same.basisKey, 'the requested cache key is fingerprint plus editorial revision');
  assert.notEqual(base.basisKey, edited.basisKey);
  assert.notEqual(base.observationId, same.observationId, 'evidence remains bound to its exact observation');
});

test('research uses curator location and schedule overrides as already-satisfied fields', () => {
  const effective = researchEffectiveNormalizedFields(
    {
      title: 'Original title',
      sourceUrl: 'https://fixture.example/events/cleanup',
    },
    {
      location: 'Curator-confirmed park',
      schedule: {
        kind: 'ONE_TIME',
        localStart: '2026-08-15T08:30:00-10:00',
        localEnd: '2026-08-15T10:00:00-10:00',
      },
    },
  );
  assert.equal(effective.location, 'Curator-confirmed park');
  assert.deepEqual(effective.locationLabels, ['Curator-confirmed park']);
  assert.equal(effective.localStart, '2026-08-15T08:30:00-10:00');
  assert.equal(effective.localEnd, '2026-08-15T10:00:00-10:00');
});

test('Brave provider is opt-in, uses its fixed API endpoint, and never returns response text', async () => {
  assert.equal(researchSearchProviderFromEnvironment({}), undefined);
  assert.equal(researchSearchProviderFromEnvironment({
    MATCHBOOK_RESEARCH_SEARCH_PROVIDER: 'BRAVE',
  }), undefined);

  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const provider = new BraveResearchSearchProvider('private-key', async (url, init) => {
    requestedUrl = String(url);
    requestedInit = init;
    return new Response(JSON.stringify({
      web: {
        results: [{
          title: 'Public event',
          url: 'https://fixture.example/events/cleanup',
          description: 'A response snippet that must not leave this boundary.',
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const results = await provider.search('Community cleanup Kauai');

  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('count'), '5');
  assert.equal(url.searchParams.get('safesearch'), 'strict');
  assert.equal(new Headers(requestedInit?.headers).get('X-Subscription-Token'), 'private-key');
  assert.deepEqual(results, [{ url: 'https://fixture.example/events/cleanup' }]);
  assert.equal(JSON.stringify(results).includes('snippet'), false);
  assert.equal(JSON.stringify(results).includes('response'), false);
});
