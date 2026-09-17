import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveSourceAdapter } from '../src/adapters/live-source.js';
import { suggestClassification } from '../src/classification.js';
import type { SourceDefinition } from '../src/contracts.js';
import { syntheticSource } from './fixtures.js';

const liveSource = (kind: SourceDefinition['adapterKind']): SourceDefinition => ({
  ...syntheticSource(),
  id: 'SRC-TEST',
  adapterKind: kind,
  adapterConfig: kind === 'TRIBE_REST'
    ? { kind, perPage: 50 }
    : kind === 'STATIC_JSON'
      ? { kind, eventSelector: 'value.category === events' }
      : kind === 'ICS'
        ? { kind, materializationDays: 120 }
        : kind === 'JSON_LD_HTML'
          ? { kind, detailLinkSelector: 'a' }
          : { kind: 'SOURCE_HTML', detailLinkSelector: 'a', sitemap: false },
  permission: 'PROBE_REQUIRED',
  polling: {
    ...syntheticSource().polling,
    lookBackDays: 365,
    lookAheadDays: 365,
    maxItems: 100,
  },
});

const extract = async (kind: SourceDefinition['adapterKind'], text: string, mediaType: string) => {
  const adapter = new LiveSourceAdapter(kind);
  return adapter.extract({
    bytes: new TextEncoder().encode(text),
    mediaType,
    sourceUrl: 'https://fixture.example/events',
    statusCode: 200,
    responseHeaders: {},
  }, liveSource(kind));
};

test('TRIBE REST events normalize into reviewable dated candidates', async () => {
  const result = await extract('TRIBE_REST', JSON.stringify({ events: [{
    id: 42,
    title: 'Community cleanup',
    start_date: '2026-08-15 08:30:00',
    end_date: '2026-08-15 10:30:00',
    timezone: 'Pacific/Honolulu',
    venue: { venue: 'Lydgate Beach', address: 'Nalu Rd', city: 'Kapaʻa' },
    url: 'https://fixture.example/events/42',
    status: 'publish',
  }] }), 'application/json');
  assert.equal(result.completeness, 'COMPLETE');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.normalizedFields.title, 'Community cleanup');
  assert.equal(result.items[0]?.normalizedFields.localStart, '2026-08-15T08:30:00-10:00');
  assert.match(`${result.items[0]?.normalizedFields.location}`, /Lydgate Beach/);
});

test('static community data expands publisher day indexes without timezone drift', async () => {
  const day = Math.floor(Date.parse('2026-08-16T00:00:00Z') / 86_400_000);
  const result = await extract('STATIC_JSON', JSON.stringify({
    market: {
      category: 'events',
      name: 'Sunday market',
      note: 'Local makers',
      when: { start: 900, end: 1230, uday: [day] },
      where: { name: 'Town square', address: '1 Main St' },
    },
  }), 'application/json');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.normalizedFields.localStart, '2026-08-16T09:00:00-10:00');
});

test('ICS weekly recurrences are materialized inside the review horizon', async () => {
  const result = await extract('ICS', [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:weekly-1',
    'DTSTART:20260810T180000',
    'DTEND:20260810T190000',
    'RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO',
    'SUMMARY:Monday gathering',
    'LOCATION:Līhuʻe Library',
    'CATEGORIES:Live Music,Community',
    'DESCRIPTION:A public kanikapila for neighbors.',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'), 'text/calendar');
  assert.equal(result.items.length, 4);
  assert.equal(new Set(result.items.map(item => item.sourceItemKey)).size, 4);
  assert.deepEqual(result.items[0]?.normalizedFields.categories, ['Live Music', 'Community']);
  assert.equal(result.items[0]?.normalizedFields.description, 'A public kanikapila for neighbors.');
});

test('JSON-LD pages retain official event facts and ignore unrelated nodes', async () => {
  const result = await extract('JSON_LD_HTML', `
    <script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Event","@id":"event-7",
      "name":"Lei workshop","startDate":"2026-08-20T17:00:00-10:00",
      "location":{"@type":"Place","name":"Community Hall"}
    }</script>
    <script type="application/ld+json">{"@type":"Organization","name":"Not an event"}</script>
  `, 'text/html');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.normalizedFields.title, 'Lei workshop');
});

test('visible event cards retain safe context and emit named-place clues without inventing locations', async () => {
  const result = await extract('SOURCE_HTML', `
    <section>
      <article data-category="volunteer-service">
        <h2>Saturday gathering</h2>
        <time datetime="2026-08-21T08:00:00-10:00"></time>
        <div class="summary">Help care for Lydgate Beach Park.</div>
        <span class="host">Kauaʻi Surfrider</span>
        <p>Gloves provided. Email crew@example.com or call 808-555-1212.</p>
      </article>
      <article>
        <h2>Sunday reflection</h2>
        <time datetime="2026-08-22T09:00:00-10:00"></time>
        <p>Meet at All Saints Church before the program.</p>
      </article>
      <article>
        <h2>Neighborhood workshop</h2>
        <time datetime="2026-08-23T10:00:00-10:00"></time>
        <p>Program convenes at Kīlauea Community Center.</p>
      </article>
    </section>
  `, 'text/html');
  assert.equal(result.items.length, 3);
  const byTitle = new Map(result.items.map(item => [item.normalizedFields.title, item.normalizedFields]));
  assert.equal(byTitle.get('Saturday gathering')?.locationHint, 'Lydgate Beach Park');
  assert.equal(byTitle.get('Sunday reflection')?.locationHint, 'All Saints Church');
  assert.equal(byTitle.get('Neighborhood workshop')?.locationHint, 'Kīlauea Community Center');
  for (const fields of byTitle.values()) {
    assert.equal(fields.location, undefined, 'a clue must not be promoted to a canonical location');
    assert.deepEqual(fields.researchNeeded, ['location']);
  }
  assert.match(`${byTitle.get('Saturday gathering')?.description}`, /Gloves provided/);
  assert.doesNotMatch(`${byTitle.get('Saturday gathering')?.description}`, /crew@example|808-555-1212/);
  assert.equal(
    byTitle.get('Saturday gathering')?.reviewDescription,
    byTitle.get('Saturday gathering')?.description,
  );
  assert.equal(byTitle.get('Saturday gathering')?.reviewContextVersion, 'safe-review.v1');
  assert.deepEqual(byTitle.get('Saturday gathering')?.categories, ['volunteer-service']);
  assert.equal(byTitle.get('Saturday gathering')?.context, 'Kauaʻi Surfrider');
});

test('invalid publisher end times are omitted and explicitly queued for schedule research', async () => {
  const day = Math.floor(Date.parse('2026-08-24T00:00:00Z') / 86_400_000);
  const result = await extract('STATIC_JSON', JSON.stringify({
    mathPrep: {
      category: 'events',
      name: 'Math Prep Week',
      topic: 'education',
      tag: ['math', 'students'],
      kine: 'class',
      note: 'Prepare for the new term.',
      web: 'https://fixture.example/events/math-prep-week',
      when: { start: 1600, end: 900, uday: [day] },
    },
  }), 'application/json');
  const fields = result.items[0]?.normalizedFields ?? {};
  assert.equal(fields.localEnd, undefined);
  assert.deepEqual(fields.researchNeeded, ['location', 'schedule']);
  assert.equal(fields.sourceUrl, 'https://fixture.example/events/math-prep-week');
  assert.deepEqual(fields.categories, ['education', 'math', 'students', 'class']);
  const classification = suggestClassification({
    entityHint: 'event',
    normalizedFields: fields,
    source: liveSource('STATIC_JSON'),
  });
  assert.deepEqual([classification.topicKey, classification.subcategoryKey], ['books', 'classes_workshops']);
});

test('richer source fields classify all regression artifacts instead of generic fallback', async () => {
  const staticDay = Math.floor(Date.parse('2026-08-19T00:00:00Z') / 86_400_000);
  const artifacts = [
    await extract('SOURCE_HTML', `
      <article data-category="farmers-market">
        <h2>Saturday gathering</h2>
        <time datetime="2026-08-16T09:00:00-10:00"></time>
        <div class="summary">Fresh local produce</div>
      </article>
    `, 'text/html'),
    await extract('JSON_LD_HTML', `
      <script type="application/ld+json">{
        "@context":"https://schema.org","@type":"Event","@id":"generic-yoga",
        "name":"Morning practice","startDate":"2026-08-17T08:00:00-10:00",
        "keywords":["yoga","stretch"]
      }</script>
    `, 'text/html'),
    await extract('TRIBE_REST', JSON.stringify({ events: [{
      id: 3,
      title: 'Island gathering',
      start_date: '2026-08-18 09:00:00',
      categories: [{ name: 'Volunteer & service' }],
    }] }), 'application/json'),
    await extract('STATIC_JSON', JSON.stringify({
      ampedUp: {
        category: 'events',
        name: 'Amped Up',
        topic: 'local-show',
        tag: ['music', 'free'],
        kine: 'market',
        note: 'Featuring a rotating troupe of unsigned artists.',
        when: { start: 1900, end: 2200, uday: [staticDay] },
        where: { name: 'Anahola Marketplace' },
      },
    }), 'application/json'),
  ];
  const suggestions = artifacts.map((artifact, index) => {
    const item = artifact.items[0];
    assert.ok(item);
    const kind = ['SOURCE_HTML', 'JSON_LD_HTML', 'TRIBE_REST', 'STATIC_JSON'][index] as SourceDefinition['adapterKind'];
    return suggestClassification({
      entityHint: 'event',
      normalizedFields: item.normalizedFields,
      source: liveSource(kind),
    });
  });
  assert.deepEqual(suggestions.map(item => [item.topicKey, item.subcategoryKey]), [
    ['food', 'farmers_market'],
    ['wellness', 'yoga_meditation'],
    ['community', 'volunteer_service'],
    ['music', 'live_music'],
  ]);
  assert.equal(suggestions.filter(item => !item.reasons.includes('FALLBACK_COMMUNITY')).length, 4);
});

test('document monitors create visible but undated review candidates', async () => {
  const adapter = new LiveSourceAdapter('PDF_MONITOR');
  const source = {
    ...liveSource('SOURCE_HTML'),
    adapterKind: 'PDF_MONITOR' as const,
    adapterConfig: { kind: 'PDF_MONITOR' as const, changeReviewOnly: true as const },
  };
  const result = await adapter.extract({
    bytes: new TextEncoder().encode('<a href="/programs/summer.pdf">Summer programs</a>'),
    mediaType: 'text/html',
    sourceUrl: 'https://fixture.example/programs',
    statusCode: 200,
    responseHeaders: {},
  }, source);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.normalizedFields.localStart, undefined);
});
