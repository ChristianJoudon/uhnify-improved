import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceDefinition } from '../src/contracts.js';
import { SafeHttpClient } from '../src/safe-http-client.js';
import { fetchSourceArtifact } from '../src/source-execution.js';
import { syntheticSource } from './fixtures.js';

/** A client whose transport answers from a table, recording every URL asked. */
const fakeClient = (answers: Record<string, { body: string; type?: string }>, asked: string[]) => new SafeHttpClient({
  userAgent: 'MatchBook-Ingestion/0.1 (+https://matchbook.example/crawler)',
  resolveHost: async () => ['93.184.216.34'],
  transport: async (url: string) => {
    asked.push(url);
    const answer = answers[url];
    if (!answer) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(answer.body, { status: 200, headers: { 'content-type': answer.type ?? 'application/json' } });
  },
  sleep: async () => {},
});

const pagesOf = (artifact: { bytes: Uint8Array }): Array<{ url: string; text: string }> => (
  JSON.parse(new TextDecoder().decode(artifact.bytes)).pages
);

const kauaiToday = (): string => new Date(Date.now() - 10 * 3_600_000).toISOString().slice(0, 10);

test('date placeholders in an endpoint become the polling window on Kauaʻi’s calendar', async () => {
  const source: SourceDefinition = {
    ...syntheticSource(),
    adapterKind: 'STATIC_JSON',
    adapterConfig: { kind: 'STATIC_JSON', eventSelector: 'events' },
    polling: { ...syntheticSource().polling, lookBackDays: 0, lookAheadDays: 30 },
    endpoints: [
      { purpose: 'COLLECTION', method: 'GET', urlTemplate: 'https://fixture.example/api?from={START_DATE}&to={END_DATE}' },
      { purpose: 'COLLECTION', method: 'GET', urlTemplate: 'https://fixture.example/api?from={DATE+31}&to={DATE+60}' },
    ],
  };
  const asked: string[] = [];
  const today = kauaiToday();
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const client = fakeClient({
    [`https://fixture.example/api?from=${today}&to=${day(30)}`]: { body: '{"events":[{"id":1}]}' },
    [`https://fixture.example/api?from=${day(31)}&to=${day(60)}`]: { body: '{"events":[{"id":2}]}' },
  }, asked);
  const artifact = await fetchSourceArtifact(source, client);
  assert.deepEqual(asked, [
    `https://fixture.example/api?from=${today}&to=${day(30)}`,
    `https://fixture.example/api?from=${day(31)}&to=${day(60)}`,
  ], 'every COLLECTION endpoint is fetched, with its dates filled in');
  assert.equal(pagesOf(artifact).length, 2);
});

test('a later window that fails is a partial read, not a failed source', async () => {
  const source: SourceDefinition = {
    ...syntheticSource(),
    adapterKind: 'ICS',
    adapterConfig: { kind: 'ICS', materializationDays: 120 },
    httpPolicy: { ...syntheticSource().httpPolicy, allowedMediaTypes: ['text/calendar'] },
    endpoints: [
      { purpose: 'COLLECTION', method: 'GET', urlTemplate: 'https://fixture.example/music.ics' },
      { purpose: 'COLLECTION', method: 'GET', urlTemplate: 'https://fixture.example/gone.ics' },
      { purpose: 'COLLECTION', method: 'GET', urlTemplate: 'https://fixture.example/art.ics' },
    ],
  };
  const asked: string[] = [];
  const client = fakeClient({
    'https://fixture.example/music.ics': { body: 'BEGIN:VCALENDAR\nEND:VCALENDAR', type: 'text/calendar' },
    'https://fixture.example/art.ics': { body: 'BEGIN:VCALENDAR\nEND:VCALENDAR', type: 'text/calendar' },
  }, asked);
  const pages = pagesOf(await fetchSourceArtifact(source, client));
  assert.deepEqual(pages.map(page => page.url), ['https://fixture.example/music.ics', 'https://fixture.example/art.ics']);

  const firstGone: SourceDefinition = { ...source, endpoints: [source.endpoints[1]!, source.endpoints[0]!] };
  await assert.rejects(fetchSourceArtifact(firstGone, fakeClient({}, [])), /MIME_REJECTED|404|disallowed/i);
});

test('a list page’s event links are followed to the pages that carry the dates', async () => {
  const source: SourceDefinition = {
    ...syntheticSource(),
    adapterKind: 'JSON_LD_HTML',
    adapterConfig: { kind: 'JSON_LD_HTML', detailLinkSelector: 'a.eventlist-title-link' },
    httpPolicy: { ...syntheticSource().httpPolicy, allowedMediaTypes: ['text/html'] },
    polling: { ...syntheticSource().polling, maxPages: 2 },
    endpoints: [{ purpose: 'COLLECTION', method: 'GET', urlTemplate: 'https://fixture.example/events' }],
  };
  const list = `<html><body>
    <a class="eventlist-title-link" href="/events/coffee-time">Coffee Time</a>
    <a class="eventlist-title-link" href="/events/coffee-time#again">Coffee Time again</a>
    <a class="eventlist-title-link" href="https://elsewhere.example/events/other">Not ours</a>
    <a class="eventlist-title-link" href="/events/book-club">Book club</a>
    <a class="eventlist-title-link" href="/events/third">Over the page budget</a>
    <a href="/about">About</a>
  </body></html>`;
  const asked: string[] = [];
  const client = fakeClient({
    'https://fixture.example/events': { body: list, type: 'text/html' },
    'https://fixture.example/events/coffee-time': { body: '<html>coffee</html>', type: 'text/html' },
    'https://fixture.example/events/book-club': { body: '<html>books</html>', type: 'text/html' },
  }, asked);
  const pages = pagesOf(await fetchSourceArtifact(source, client));
  assert.deepEqual(asked, [
    'https://fixture.example/events',
    'https://fixture.example/events/coffee-time',
    'https://fixture.example/events/book-club',
  ], 'same host only, no repeats, no fragments, at most the page budget');
  assert.equal(pages.length, 3);
});
