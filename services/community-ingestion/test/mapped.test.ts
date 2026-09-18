import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { LiveSourceAdapter } from '../src/adapters/live-source.js';
import { SourceDefinitionSchema, type SourceDefinition } from '../src/contracts.js';
import { inferSelectors, parseRobots, robotsAllows } from '../src/probe.js';
import { syntheticSource } from './fixtures.js';

const NOW = '2026-09-17T20:00:00Z'; // 10 AM on Kauaʻi, Thursday 17 September 2026

const source = (overrides: Record<string, unknown>): SourceDefinition => SourceDefinitionSchema.parse({
  ...syntheticSource(),
  id: 'SRC-TEST',
  polling: { ...syntheticSource().polling, lookBackDays: 1, lookAheadDays: 120, maxItems: 500 },
  ...overrides,
});

const read = async (definition: SourceDefinition, text: string, mediaType: string) => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  try {
    const result = await new LiveSourceAdapter(definition.adapterKind).extract({
      bytes: new TextEncoder().encode(text), mediaType, sourceUrl: 'https://fixture.example/events', statusCode: 200, responseHeaders: {},
    }, definition);
    return { ...result, rows: result.items.map(item => item.normalizedFields).sort((a, b) => `${a.localStart}${a.localEnd}`.localeCompare(`${b.localStart}${b.localEnd}`)) };
  } finally {
    mock.timers.reset();
  }
};

test('a JSON API is read by the register’s description of it: paths, a date spelled M-D-YYYY, a clock in milliseconds, a rule in words', async () => {
  const definition = source({
    adapterKind: 'STATIC_JSON',
    adapterConfig: { kind: 'STATIC_JSON', eventSelector: 'event cache', records: {
      fields: { id: 'eventHash', title: 'title', date: 'dates.0.date', time: 'dates.0.startTime', endTime: 'dates.0.endTime',
        recurrence: 'dates.0.dateString', location: ['address', 'region'], categories: 'category', url: 'website' },
      recurrenceWeeks: 3,
    } },
  });
  const { rows } = await read(definition, JSON.stringify([
    { eventHash: 'a1', title: 'Improv &amp; Open Mic', address: '4411 Kikowaena St.', region: 'Lihue', category: 'Arts & Culture,Community', website: '',
      userEmail: 'someone@example.org', dates: [{ date: '9-18-2026', dateString: 'Fri, Sep 18, 2026', startTime: 63_000_000, endTime: 79_200_000 }] },
    { eventHash: 'b2', title: 'KANIKAPILA', address: 'The Shops', region: 'South Shore', category: 'Music', website: 'https://shops.example/events',
      dates: [{ date: '9-18-2026', dateString: 'Every Friday', startTime: 63_000_000, endTime: 70_200_000 }] },
  ]), 'application/json');
  assert.deepEqual(rows.map(row => [row.localStart, row.localEnd, row.title]), [
    ['2026-09-18T17:30:00-10:00', '2026-09-18T19:30:00-10:00', 'KANIKAPILA'],
    ['2026-09-18T17:30:00-10:00', '2026-09-18T22:00:00-10:00', 'Improv & Open Mic'],
    ['2026-09-25T17:30:00-10:00', '2026-09-25T19:30:00-10:00', 'KANIKAPILA'],
    ['2026-10-02T17:30:00-10:00', '2026-10-02T19:30:00-10:00', 'KANIKAPILA'],
    ['2026-10-09T17:30:00-10:00', '2026-10-09T19:30:00-10:00', 'KANIKAPILA'],
  ]);
  assert.equal(rows[1]?.location, '4411 Kikowaena St., Lihue');
  assert.deepEqual(rows[1]?.categories, ['Arts & Culture', 'Community']);
  assert.equal(rows[0]?.sourceUrl, 'https://shops.example/events');
});

test('records keyed by date, filtered by a field, with the JSON sitting inside an HTML page', async () => {
  const definition = source({
    adapterKind: 'STATIC_JSON',
    adapterConfig: { kind: 'STATIC_JSON', eventSelector: 'bootstrap state', records: {
      htmlJson: { marker: 'window.__STATE__ =' }, path: 'days.*.*',
      fields: { title: 'event_title', start: 'occur_begin', end: 'occur_end', location: ['place'] },
      include: { field: 'area', pattern: 'kaua' },
    } },
  });
  const state = { days: {
    '2026-10-07': [{ event_title: 'Legion Post 54 Meeting', occur_begin: '2026-10-07 17:15:00', occur_end: '2026-10-07 18:15:00', place: 'Veterans Center', area: 'Kauaʻi' }],
    '2026-10-08': [{ event_title: 'Honolulu thing', occur_begin: '2026-10-08 09:00:00', area: 'Oʻahu' }],
  } };
  const { rows } = await read(definition, `<html><script>window.__STATE__ = ${JSON.stringify(state)}; var after = {"x": "}"};</script></html>`, 'text/html');
  assert.deepEqual(rows.map(row => [row.localStart, row.title, row.location]), [['2026-10-07T17:15:00-10:00', 'Legion Post 54 Meeting', 'Veterans Center']]);
});

test('a blog that announces events: the date is in the post, not on it', async () => {
  const definition = source({
    adapterKind: 'STATIC_JSON',
    adapterConfig: { kind: 'STATIC_JSON', eventSelector: 'wp posts', records: {
      fields: { id: 'id', title: 'title.rendered', prose: 'content.rendered', published: 'date', url: 'link' },
    } },
  });
  const { rows } = await read(definition, JSON.stringify([
    { id: 1, date: '2026-09-10T08:00:00', link: 'https://fixture.example/family-day', title: { rendered: 'Community Outreach &amp; Family Fun Day' },
      content: { rendered: '<p>Join us Tuesday, October 6, 2026, from 10:00 AM to 3:00 PM at Lydgate Pavilion in Wailua. Founded in 1975.</p>' } },
    { id: 2, date: '2026-09-01T08:00:00', link: 'https://fixture.example/thanks', title: { rendered: 'Mahalo to our donors' }, content: { rendered: '<p>Thank you all.</p>' } },
  ]), 'application/json');
  assert.deepEqual(rows.map(row => [row.localStart, row.localEnd, row.title]), [['2026-10-06T10:00:00-10:00', '2026-10-06T15:00:00-10:00', 'Community Outreach & Family Fun Day']]);
});

test('a page of rows: selectors for the parts, the year from the heading, word breaks kept', async () => {
  const definition = source({
    adapterKind: 'SOURCE_HTML',
    httpPolicy: { ...syntheticSource().httpPolicy, allowedMediaTypes: ['text/html'] },
    adapterConfig: { kind: 'SOURCE_HTML', detailLinkSelector: 'a', sitemap: false, followDetails: false, selectors: {
      item: 'div.eventitem', title: 'h3', date: 'div.eventdate', time: 'span.eventtime', location: 'span.eventlocation a', yearFrom: 'div.selectedmonth',
    } },
  });
  const { rows } = await read(definition, `<div class="selectedmonth">October 2026</div>
    <div class="row eventitem"><div class="eventdate"><span>Sat</span><br><span>03</span><br><span>Oct</span></div>
      <h3>Anaina Hou Farmers Market</h3><p><span class="eventlocation">Location: <a href="https://anainahou.org/">Anaina Hou Community Park</a></span>
      <span class="eventtime">Saturdays, <svg><path d="M1 2"/></svg> Time: 9:00 am - 12:00 pm</span></p></div>`, 'text/html');
  assert.deepEqual(rows.map(row => [row.localStart, row.localEnd, row.title, row.location]),
    [['2026-10-03T09:00:00-10:00', '2026-10-03T12:00:00-10:00', 'Anaina Hou Farmers Market', 'Anaina Hou Community Park']]);
});

test('a bulletin of lines: the line is the title with its date taken out; a list of days is several events; reading stops where told', async () => {
  const definition = source({
    adapterKind: 'SOURCE_HTML',
    adapterConfig: { kind: 'SOURCE_HTML', detailLinkSelector: 'a', sitemap: false, followDetails: false, selectors: {
      item: 'div.desc p, div.box', date: 'h3', stopAt: '^Previous Concerts', defaultLocation: 'Līhuʻe Christian Church',
    } },
  });
  const { rows } = await read(definition, `<div class="desc">
      <p>Sunday 9/20: 9:30 a.m. Annual Church Picnic @ Lydgate Beach Park</p>
      <p>Tuesday 9/22: 5:30 p.m. KAUCC General Meeting</p><p>Office closed Mondays.</p></div>
    <div class="box"><h3>September 27th &amp; October 4th</h3><p><b>The Apostles' Creed</b><br>Parish Hall 9am</p></div>
    <h2>Previous Concerts</h2><div class="desc"><p>October 30: A concert that already happened in another year</p></div>`, 'text/html');
  assert.deepEqual(rows.map(row => [row.localStart, row.title]), [
    ['2026-09-20T09:30:00-10:00', 'Annual Church Picnic @ Lydgate Beach Park'],
    ['2026-09-22T17:30:00-10:00', 'KAUCC General Meeting'],
    ['2026-09-27T09:00:00-10:00', 'The Apostles’ Creed Parish Hall'],
    ['2026-10-04T09:00:00-10:00', 'The Apostles’ Creed Parish Hall'],
  ].map(([start, title]) => [start, title!.replace('’', "'")]));
  assert.ok(rows.every(row => row.location === 'Līhuʻe Christian Church'));
});

test('a directory of weekly markets: the weekday is the heading over the line, written out for the weeks asked', async () => {
  const definition = source({
    adapterKind: 'SOURCE_HTML',
    adapterConfig: { kind: 'SOURCE_HTML', detailLinkSelector: 'a', sitemap: false, followDetails: false, selectors: {
      item: 'li.section-content p', title: 'strong', dateFrom: 'h4', weeklyWeeks: 2, exclude: 'food tour',
    } },
  });
  const { rows } = await read(definition, `<ul><li class="section-content"><h4>Tuesday</h4>
      <p><strong>Waipā Farmers Market</strong>, Waipā, 2 p.m. to dusk. Produce and crafts.</p>
      <p><strong>Book our North Shore food tour</strong> any day.</p>
      <h4>Saturday</h4><p><strong>Kauaʻi Community Market</strong>, KCC, 9:30 a.m. to 1 p.m.</p></li></ul>`, 'text/html');
  assert.deepEqual(rows.map(row => [row.localStart, row.localEnd, row.title]), [
    ['2026-09-19T09:30:00-10:00', '2026-09-19T13:00:00-10:00', 'Kauaʻi Community Market'],
    ['2026-09-22T14:00:00-10:00', undefined, 'Waipā Farmers Market'],
    ['2026-09-26T09:30:00-10:00', '2026-09-26T13:00:00-10:00', 'Kauaʻi Community Market'],
    ['2026-09-29T14:00:00-10:00', undefined, 'Waipā Farmers Market'],
  ]);
});

test('RSS: the event’s date is the one written in the post, never the post’s own; an article with no date is not an event', async () => {
  const definition = source({
    adapterKind: 'RSS_ATOM',
    httpPolicy: { ...syntheticSource().httpPolicy, allowedMediaTypes: ['application/rss+xml'] },
    adapterConfig: { kind: 'RSS_ATOM', identityField: 'link' },
  });
  const { rows } = await read(definition, `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <item><title>Music Under the Monkeypods, November</title><link>https://fixture.example/monkeypods-november/</link>
      <pubDate>Tue, 15 Sep 2026 18:00:00 +0000</pubDate><category>event</category>
      <content:encoded><![CDATA[<p><strong>Date &amp; Time: </strong>Sunday, November 29, 3-6 PM<br>Waikomo Courtyard. Since 2019.</p>]]></content:encoded></item>
    <item><title>New shop opens</title><link>https://fixture.example/new-shop/</link><pubDate>Mon, 14 Sep 2026 18:00:00 +0000</pubDate>
      <description>Welcome our newest tenant.</description></item></channel></rss>`, 'application/rss+xml');
  assert.deepEqual(rows.map(row => [row.localStart, row.localEnd, row.title, row.sourceUrl]),
    [['2026-11-29T15:00:00-10:00', '2026-11-29T18:00:00-10:00', 'Music Under the Monkeypods, November', 'https://fixture.example/monkeypods-november/']]);
});

test('a recovery meeting on a hall’s calendar is not collected; a cancelled event says so', async () => {
  const definition = source({ adapterKind: 'ICS', adapterConfig: { kind: 'ICS', materializationDays: 120 } });
  const result = await read(definition, ['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:1', 'DTSTART:20260924T190000', 'SUMMARY:Thursday N/A (Narcotics Anonymous)', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:2', 'DTSTART:20260925T180000', 'SUMMARY:Slack Key Concert', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:3', 'DTSTART:20261003T100000', 'SUMMARY:CANCELLED - Harvest Festival', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n'), 'text/calendar');
  assert.deepEqual(result.rows.map(row => [row.title, row.realityStatus]), [['Slack Key Concert', 'SCHEDULED'], ['CANCELLED - Harvest Festival', 'CANCELLED']]);
  assert.equal(result.completeness, 'COMPLETE', 'withholding is a rule, not a partial read');
  assert.deepEqual(result.warnings.map(warning => warning.code), ['SENSITIVE_WITHHELD']);
});

test('robots.txt is read the way crawlers agree to read it', () => {
  const groups = parseRobots(['User-agent: *', 'Disallow: /*?', 'Disallow: /calendar/action*', 'Allow: /wp-json/', 'Crawl-delay: 3', '',
    'User-agent: BadBot', 'Disallow: /'].join('\n'));
  assert.deepEqual(robotsAllows(groups, '/wp-json/tribe/events/v1/events'), { allowed: true, crawlDelay: 3, rule: 'Allow: /wp-json/' });
  assert.equal(robotsAllows(groups, '/events/?ical=1').allowed, false, 'any query string is off limits');
  assert.equal(robotsAllows(groups, '/wp-json/tribe/events/v1/events?page=2').allowed, true, 'the longer rule wins, and it is the Allow');
  assert.equal(robotsAllows(groups, '/events/').allowed, true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nAllow: /$\nDisallow: /'), '/calendar/ical/x/public/basic.ics').allowed, false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:'), '/anything').allowed, true);
  assert.equal(robotsAllows(parseRobots('User-agent: MatchBookCommunityRegister\nDisallow: /\n\nUser-agent: *\nAllow: /'), '/events').allowed, false, 'a group naming us applies to us');
});

test('the repeated element that carries a page’s dates is found without being told', () => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  try {
    const html = `<body><nav><a>Oct 1</a></nav><div class="list">${['October 3', 'October 10', 'October 17'].map(day => (
      `<div class="card event-card"><h3 class="card-title">Market day</h3><span class="when">${day}, 2026</span></div>`)).join('')}</div></body>`;
    assert.deepEqual(inferSelectors(html), { item: 'div.card.event-card', title: 'h3.card-title' });
    assert.equal(inferSelectors('<body><p>No dates here at all.</p></body>'), undefined);
  } finally {
    mock.timers.reset();
  }
});
