import assert from 'node:assert/strict';
import test from 'node:test';
import type { HttpPolicy } from '../src/contracts.js';
import { SafeHttpClient, SafeHttpError } from '../src/safe-http-client.js';

const policy = (overrides: Partial<HttpPolicy> = {}): HttpPolicy => ({
  allowedHosts: ['fixture.example'],
  allowedRedirectHosts: [],
  allowedMediaTypes: ['application/json'],
  timeoutMs: 100,
  maxResponseBytes: 1_000,
  maxRedirects: 1,
  minimumDelayMs: 0,
  ...overrides,
});

const request = { method: 'GET' as const, url: 'https://fixture.example/events.json' };

const client = (transport: (url: string, init: RequestInit) => Promise<Response>, addresses = ['93.184.216.34']) => (
  new SafeHttpClient({
    userAgent: 'MatchBook-Ingestion/0.1 (+https://matchbook.example/crawler)',
    resolveHost: async () => addresses,
    transport,
    sleep: async () => {},
    now: () => Date.parse('2026-08-08T12:00:00.000Z'),
  })
);

const expectCode = async (promise: Promise<unknown>, code: string): Promise<SafeHttpError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SafeHttpError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected SafeHttpError ${code}`);
};

test('safe HTTP rejects private DNS answers before transport', async () => {
  let called = false;
  const http = client(async () => {
    called = true;
    return new Response();
  }, ['127.0.0.1']);

  await expectCode(http.fetch(request, policy()), 'DNS_IP_BLOCKED');
  assert.equal(called, false);
});

test('safe HTTP revalidates redirect hosts', async () => {
  const http = client(async () => new Response(null, {
    status: 302,
    headers: { location: 'https://unapproved.example/events.json' },
  }));

  await expectCode(http.fetch(request, policy()), 'HOST_NOT_ALLOWED');
});

test('safe HTTP discards a redirect body before following it', async () => {
  let calls = 0;
  let redirectCancelled = false;
  const redirectBody = new ReadableStream<Uint8Array>({
    cancel() {
      redirectCancelled = true;
    },
  });
  const http = client(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(redirectBody, {
        status: 302,
        headers: { location: 'https://cdn.fixture.example/events.json' },
      });
    }
    assert.equal(redirectCancelled, true, 'redirect stream must close before the next request');
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const result = await http.fetch(request, policy({ allowedRedirectHosts: ['cdn.fixture.example'] }));
  assert.equal(result.sourceUrl, 'https://cdn.fixture.example/events.json');
  assert.equal(calls, 2);
});

test('safe HTTP discards bodies before status, media, and announced-size errors', async () => {
  const cases: Array<{
    code: string;
    response: (body: ReadableStream<Uint8Array>) => Response;
    responsePolicy?: Partial<HttpPolicy>;
  }> = [
    {
      code: 'HTTP_5XX',
      response: body => new Response(body, { status: 503 }),
    },
    {
      code: 'MIME_REJECTED',
      response: body => new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } }),
    },
    {
      code: 'BODY_TOO_LARGE',
      response: body => new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '50' },
      }),
      responsePolicy: { maxResponseBytes: 10 },
    },
  ];

  for (const item of cases) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const http = client(async () => item.response(body));
    await expectCode(http.fetch(request, policy(item.responsePolicy)), item.code);
    assert.equal(cancelled, true, `${item.code} must cancel its unused response body`);
  }
});

test('safe HTTP rejects disallowed media and oversized bodies', async () => {
  const wrongMedia = client(async () => new Response('<events/>', {
    status: 200,
    headers: { 'content-type': 'application/xml' },
  }));
  await expectCode(wrongMedia.fetch(request, policy()), 'MIME_REJECTED');

  const announcedTooLarge = client(async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '50' },
  }));
  await expectCode(announcedTooLarge.fetch(request, policy({ maxResponseBytes: 10 })), 'BODY_TOO_LARGE');

  const decodedTooLarge = client(async () => new Response('01234567890', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await expectCode(decodedTooLarge.fetch(request, policy({ maxResponseBytes: 10 })), 'BODY_TOO_LARGE');
});

test('safe HTTP cancels a chunked response as soon as its decoded byte limit is crossed', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('123456'));
      controller.enqueue(new TextEncoder().encode('789012'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const http = client(async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  await expectCode(http.fetch(request, policy({ maxResponseBytes: 10 })), 'BODY_TOO_LARGE');
  assert.equal(cancelled, true);
});

test('safe HTTP returns only explicitly approved operational headers', async () => {
  const http = client(async () => new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      etag: 'fixture-v1',
      'set-cookie': 'session=do-not-store',
      'x-api-token': 'do-not-store-either',
    },
  }));

  const result = await http.fetch(request, policy());
  assert.deepEqual(result.responseHeaders, {
    'content-type': 'application/json',
    etag: 'fixture-v1',
  });
});

test('safe HTTP reports retry timing for rate limits', async () => {
  const http = client(async () => new Response(null, {
    status: 429,
    headers: { 'retry-after': '2' },
  }));

  const error = await expectCode(http.fetch(request, policy()), 'HTTP_429');
  assert.equal(error.retryAfterMs, 2_000);
});

test('safe HTTP aborts a request at its configured timeout', async () => {
  const http = client(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));

  await expectCode(http.fetch(request, policy({ timeoutMs: 10 })), 'FETCH_TIMEOUT');
});

test('safe HTTP timeout remains active while a response body is stalled', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const http = client(async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  await expectCode(http.fetch(request, policy({ timeoutMs: 10 })), 'FETCH_TIMEOUT');
  assert.equal(cancelled, true);
});
