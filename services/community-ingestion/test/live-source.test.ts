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

test('a JSON API in the common shape is read, with a publisher’s wall-clock "Z" times kept on Kauaʻi time', async () => {
  const adapter = new LiveSourceAdapter('STATIC_JSON');
  const source: SourceDefinition = {
    ...liveSource('STATIC_JSON'),
    adapterConfig: { kind: 'STATIC_JSON', eventSelector: 'events', timestampsAreLocal: true },
  };
  const result = await adapter.extract({
    bytes: new TextEncoder().encode(JSON.stringify({ version: 'v1', count: 2, events: [
      {
        id: '230c2216', slug: 'kupuna-jam', title: 'Kūpuna Jam Sessions at Hale Līhuʻe',
        shortDesc: 'Bring your instrument.', startDate: '2026-09-18T13:00:00.000Z', endDate: '2026-09-18T14:30:00.000Z',
        island: { slug: 'kauai', name: 'Kauai' }, location: { name: 'Hale Lihue', address: '4286 Rice Street', city: 'Lihue' },
        categories: [{ slug: 'community', name: 'Community' }], url: 'https://fixture.example/events/kupuna-jam',
      },
      { id: 'no-title', startDate: '2026-09-18T13:00:00.000Z' },
    ] })),
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/api/v1/events',
    statusCode: 200,
    responseHeaders: {},
  }, source);
  assert.equal(result.items.length, 1);
  const fields = result.items[0]?.normalizedFields ?? {};
  assert.equal(fields.title, 'Kūpuna Jam Sessions at Hale Līhuʻe');
  assert.equal(fields.localStart, '2026-09-18T13:00:00-10:00', 'a 1 PM jam session, not 3 AM');
  assert.equal(fields.localEnd, '2026-09-18T14:30:00-10:00');
  assert.match(`${fields.location}`, /Hale Lihue, 4286 Rice Street, Lihue/);
  assert.deepEqual(fields.categories, ['Community']);
  assert.equal(fields.sourceUrl, 'https://fixture.example/events/kupuna-jam');
});

test('a JSON API whose times are epoch milliseconds and true UTC is read as such', async () => {
  const adapter = new LiveSourceAdapter('STATIC_JSON');
  const source: SourceDefinition = {
    ...liveSource('STATIC_JSON'),
    adapterConfig: { kind: 'STATIC_JSON', eventSelector: 'upcoming' },
  };
  const result = await adapter.extract({
    bytes: new TextEncoder().encode(JSON.stringify({ upcoming: [{
      id: 'sq1', title: 'Fall Forest Camp', fullUrl: '/events/fall-forest-camp',
      startDate: Date.parse('2026-10-08T19:00:00Z'), endDate: Date.parse('2026-10-08T22:00:00Z'),
      location: { addressTitle: 'Storybook Theatre', addressLine1: '3814 Hanapepe Rd' },
    }], past: [{ id: 'old', title: 'Old', startDate: Date.parse('2020-01-01T00:00:00Z') }] })),
    mediaType: 'application/json',
    sourceUrl: 'https://fixture.example/events?format=json',
    statusCode: 200,
    responseHeaders: {},
  }, source);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.normalizedFields.localStart, '2026-10-08T09:00:00-10:00');
  assert.equal(result.items[0]?.normalizedFields.location, 'Storybook Theatre, 3814 Hanapepe Rd');
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

test('County of Kauaʻi calendar items read the OpenCities shape: wall-clock date, venue, own page, cancellation', async () => {
  const adapter = new LiveSourceAdapter('COUNTY_OPENCITIES');
  const source: SourceDefinition = {
    ...liveSource('SOURCE_HTML'),
    adapterKind: 'COUNTY_OPENCITIES',
    adapterConfig: { kind: 'COUNTY_OPENCITIES', calendarDiscoveryUrl: 'https://fixture.example/ocapi/calendars/getcalendars/x' },
  };
  const page = (item: Record<string, unknown>, detail: unknown, calendar = 'Boards & Commissions') => ({
    url: `https://fixture.example/ocapi/calendars/getcalendaritems#${item.Id}`,
    mediaType: 'application/json',
    text: JSON.stringify({ item, calendar, detail }),
  });
  const soon = new Date(Date.now() + 5 * 86_400_000);
  const when = `${soon.getMonth() + 1}/${soon.getDate()}/${soon.getFullYear()} 1:00:00 PM`;
  const composite = JSON.stringify({ pages: [
    page({ Id: 'a1', CalendarId: 'c1', Name: 'CANCELLED - Board of Ethics Meeting', DateTime: when }, {
      Title: 'CANCELLED - Board of Ethics Meeting',
      Description: 'This notice is intended to satisfy HRS 92-7.',
      Link: 'https://fixture.example/Boards/Ethics/meeting',
      Address: { Venue: 'Conference Room', Street: '4444 Rice St.', Suburb: 'Lihue', Formatted: 'Conference Room, 4444 Rice St., Lihue' },
      IsCancelled: false,
    }),
    page({ Id: 'a2', CalendarId: 'c2', Name: 'Kūhiō Day Holiday', DateTime: `${soon.getMonth() + 1}/${soon.getDate()}/${soon.getFullYear()}` }, null, 'Holiday Closures'),
  ] });
  const result = await adapter.extract({
    bytes: new TextEncoder().encode(composite),
    mediaType: 'application/vnd.matchbook.source-pages+json',
    sourceUrl: 'https://fixture.example/Residents/Calendar',
    statusCode: 200,
    responseHeaders: {},
  }, source);
  assert.equal(result.items.length, 2);
  const [meeting, holiday] = result.items;
  assert.equal(meeting!.normalizedFields.title, 'Board of Ethics Meeting');
  assert.equal(meeting!.normalizedFields.localStart, `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}T13:00:00`);
  assert.equal(meeting!.normalizedFields.location, 'Conference Room, 4444 Rice St., Lihue');
  assert.equal(meeting!.normalizedFields.sourceUrl, 'https://fixture.example/Boards/Ethics/meeting');
  assert.equal(meeting!.normalizedFields.realityStatus, 'CANCELLED');
  assert.deepEqual(meeting!.normalizedFields.categories, ['Boards & Commissions']);
  assert.equal(holiday!.normalizedFields.title, 'Kūhiō Day Holiday');
  assert.equal(String(holiday!.normalizedFields.localStart).slice(11), '00:00:00');
  assert.equal(holiday!.normalizedFields.sourceUrl, 'https://fixture.example/ocapi/calendars/getcalendaritems', 'no detail: the calendar itself');
});

test('Hawaiʻi Public Radio’s Kauaʻi calendar is read from its own markup, the year inferred', async () => {
  const adapter = new LiveSourceAdapter('SOURCE_HTML');
  const source: SourceDefinition = {
    ...liveSource('SOURCE_HTML'),
    parser: { parserId: 'hpr-calendar-html', parserVersion: '1.0.0', fixtureVersion: '2026-09-17' },
  };
  const year = new Date(Date.now() - 10 * 3_600_000).getUTCFullYear();
  const html = `<html><body>
    <ps-promo class="PromoEvent" data-no-media>
      <div class="PromoEvent-link"><a href="/community-calendar/event/improv-02-06-2026-19-10-56" class="PromoEvent-link-link">
        <div class="PromoEvent-date"><p class="PromoEvent-date-date">Sep 18 <span class="PromoEvent-date-day">Friday</span></p></div></a>
      <div class="PromoEvent-content">
        <ul class="PromoEvent-categories"><li class="PromoEvent-categories-item"><a class="Link">Community Calendar: Kauai</a></li><li class="PromoEvent-categories-item"><a class="Link">Theatre</a></li></ul>
        <h3 class="PromoEvent-title"><a href="https://www.hawaiipublicradio.org/community-calendar/event/improv-02-06-2026-19-10-56" class="Link">Improv &amp; Open Mic Community Nights</a></h3>
        <div class="PromoEvent-venue PromoEvent-content-item">Puhi Theatrical Warehouse</div>
        <div class="PromoEvent-price PromoEvent-content-item">5</div>
        <div class="PromoEvent-time PromoEvent-content-item" data-recurring>05:30 PM - 10:00 PM, every month on Friday through Oct 17, ${year}.</div>
        <div class="PromoEvent-description-wrapper"><div class="PromoEvent-description"><p>Theatre games and open mic.</p></div></div>
      </div></div>
    </ps-promo>
    <ps-promo class="PromoEvent">
      <div class="PromoEvent-date"><p class="PromoEvent-date-date">Sep 26 <span class="PromoEvent-date-day">Saturday</span></p></div>
      <h3 class="PromoEvent-title"><a href="/community-calendar/event/swing-band" class="Link">The Sunset Swing Band at Kukui Grove</a></h3>
      <div class="PromoEvent-venue">Kukui Grove Center</div>
      <div class="PromoEvent-time">06:00 PM - 08:30 PM on Sat, 26 Sep ${year}</div>
    </ps-promo>
  </body></html>`;
  const result = await adapter.extract({
    bytes: new TextEncoder().encode(html),
    mediaType: 'text/html',
    sourceUrl: 'https://www.hawaiipublicradio.org/community-calendar?f0=x&p=1',
    statusCode: 200,
    responseHeaders: {},
  }, { ...source, polling: { ...source.polling, lookBackDays: 400, lookAheadDays: 400 } });
  assert.equal(result.items.length, 2);
  const [improv, swing] = result.items.map(item => item.normalizedFields);
  assert.equal(improv?.title, 'Improv & Open Mic Community Nights');
  assert.equal(improv?.localStart, `${year}-09-18T17:30:00-10:00`);
  assert.equal(improv?.localEnd, `${year}-09-18T22:00:00-10:00`);
  assert.equal(improv?.location, 'Puhi Theatrical Warehouse');
  assert.deepEqual(improv?.categories, ['Theatre']);
  assert.match(`${improv?.context}`, /every month on Friday/);
  assert.equal(improv?.sourceUrl, 'https://www.hawaiipublicradio.org/community-calendar/event/improv-02-06-2026-19-10-56');
  assert.equal(swing?.localStart, `${year}-09-26T18:00:00-10:00`, 'the dated form carries its own year');
  assert.equal(swing?.sourceUrl, 'https://www.hawaiipublicradio.org/community-calendar/event/swing-band');
});
