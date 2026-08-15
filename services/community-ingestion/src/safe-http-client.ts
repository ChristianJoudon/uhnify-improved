import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { HttpPolicy, PlannedRequest } from './contracts.js';

export type SafeHttpResult = {
  bytes: Uint8Array;
  mediaType: string;
  sourceUrl: string;
  statusCode: number;
  responseHeaders: Record<string, string>;
};

export class SafeHttpError extends Error {
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'SafeHttpError';
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

type ResolveHost = (hostname: string) => Promise<string[]>;
type FetchTransport = (url: string, init: RequestInit) => Promise<Response>;

const OPERATIONAL_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-length',
  'content-type',
  'date',
  'etag',
  'last-modified',
  'retry-after',
]);

export const filterOperationalResponseHeaders = (
  headers: Headers | Record<string, string>,
): Record<string, string> => {
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  return Object.fromEntries(
    [...entries]
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name]) => OPERATIONAL_RESPONSE_HEADERS.has(name)),
  );
};

const privateIpv4 = (address: string): boolean => {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [first = 0, second = 0] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
    || first >= 224;
};

export const isBlockedAddress = (address: string): boolean => {
  const normalized = address.toLowerCase().split('%')[0] ?? '';
  const family = isIP(normalized);
  if (family === 4) return privateIpv4(normalized);
  if (family !== 6) return true;
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) return privateIpv4(normalized.slice(7));
  return false;
};

const defaultResolveHost: ResolveHost = async hostname => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(answer => answer.address);
};

const retryAfterMs = (value: string | null, now: number): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.min(at - now, 24 * 60 * 60 * 1000));
};

export class SafeHttpClient {
  private readonly resolveHost: ResolveHost;
  private readonly transport: FetchTransport;
  private readonly userAgent: string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: {
    userAgent: string;
    resolveHost?: ResolveHost;
    transport?: FetchTransport;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
  }) {
    if (!options.userAgent.trim() || !options.userAgent.includes('+')) {
      throw new Error('Crawler user agent must include a public identity/contact URL');
    }
    this.userAgent = options.userAgent;
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.transport = options.transport ?? fetch;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  private async assertUrl(rawUrl: string, policy: HttpPolicy, redirect: boolean): Promise<URL> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new SafeHttpError('INVALID_URL', 'Source request URL is invalid');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new SafeHttpError('HOST_NOT_ALLOWED', 'Only credential-free HTTPS source URLs are allowed');
    }
    const allowed = redirect
      ? new Set([...policy.allowedHosts, ...policy.allowedRedirectHosts])
      : new Set(policy.allowedHosts);
    if (!allowed.has(url.hostname)) {
      throw new SafeHttpError('HOST_NOT_ALLOWED', `Host ${url.hostname} is not allowlisted`);
    }
    // Resolve immediately before each request, including every redirect. This
    // rejects a host that currently resolves to a private address. It is not
    // address pinning: the injected/default fetch transport performs its own DNS
    // lookup, so deployment egress controls remain part of the SSRF boundary.
    const addresses = await this.resolveHost(url.hostname);
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      throw new SafeHttpError('DNS_IP_BLOCKED', `Host ${url.hostname} resolved to a blocked address`);
    }
    return url;
  }

  private async readBoundedBody(
    response: Response,
    maxResponseBytes: number,
    controller: AbortController,
  ): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;

    const readChunk = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (controller.signal.aborted) throw new SafeHttpError('FETCH_TIMEOUT', 'Source response body timed out');
      return new Promise((resolvePromise, rejectPromise) => {
        const onAbort = () => {
          void reader.cancel('response timeout').catch(() => {});
          rejectPromise(new SafeHttpError('FETCH_TIMEOUT', 'Source response body timed out'));
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        reader.read().then(resolvePromise, rejectPromise).finally(() => {
          controller.signal.removeEventListener('abort', onAbort);
        });
      });
    };

    while (true) {
      const { done, value } = await readChunk();
      if (done) break;
      if (!value) continue;
      byteLength += value.byteLength;
      if (byteLength > maxResponseBytes) {
        controller.abort();
        await reader.cancel('response byte limit exceeded').catch(() => {});
        throw new SafeHttpError('BODY_TOO_LARGE', 'Decoded source response exceeds byte limit');
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private async discardBody(response: Response, reason: string): Promise<void> {
    if (!response.body || response.body.locked) return;
    await response.body.cancel(reason).catch(() => {});
  }

  async fetch(request: PlannedRequest, policy: HttpPolicy): Promise<SafeHttpResult> {
    let redirects = 0;
    await this.sleep(policy.minimumDelayMs);
    let url = await this.assertUrl(request.url, policy, false);

    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
      let response: Response;
      try {
        const requestInit: RequestInit = {
          method: request.method,
          headers: { ...request.headers, 'User-Agent': this.userAgent, Accept: policy.allowedMediaTypes.join(', ') },
          redirect: 'manual',
          signal: controller.signal,
          ...(request.body !== undefined ? { body: request.body } : {}),
        };
        response = await this.transport(url.toString(), requestInit);
      } catch (error) {
        clearTimeout(timer);
        if (controller.signal.aborted) throw new SafeHttpError('FETCH_TIMEOUT', 'Source request timed out');
        throw new SafeHttpError('FETCH_FAILED', (error as Error).message);
      }

      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await this.discardBody(response, 'redirect response body is not retained');
          if (!location) throw new SafeHttpError('REDIRECT_INVALID', 'Redirect response omitted Location');
          redirects += 1;
          if (redirects > policy.maxRedirects) throw new SafeHttpError('REDIRECT_LIMIT', 'Source exceeded redirect limit');
          url = await this.assertUrl(new URL(location, url).toString(), policy, true);
          continue;
        }

        if (response.status === 429) {
          await this.discardBody(response, 'rate-limited response body is not retained');
          throw new SafeHttpError(
            'HTTP_429',
            'Source rate limited the request',
            retryAfterMs(response.headers.get('retry-after'), this.now()),
          );
        }
        if (response.status >= 500) {
          await this.discardBody(response, 'server-error response body is not retained');
          throw new SafeHttpError('HTTP_5XX', `Source returned ${response.status}`);
        }
        if (response.status < 200 || response.status >= 300) {
          await this.discardBody(response, 'rejected response body is not retained');
          throw new SafeHttpError('HTTP_REJECTED', `Source returned ${response.status}`);
        }

        const announcedLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(announcedLength) && announcedLength > policy.maxResponseBytes) {
          await this.discardBody(response, 'oversized response body is not retained');
          throw new SafeHttpError('BODY_TOO_LARGE', 'Source response exceeds byte limit');
        }
        const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (!policy.allowedMediaTypes.map(value => value.toLowerCase()).includes(mediaType)) {
          await this.discardBody(response, 'disallowed media response body is not retained');
          throw new SafeHttpError('MIME_REJECTED', `Source returned disallowed media type ${mediaType || '(missing)'}`);
        }
        const bytes = await this.readBoundedBody(response, policy.maxResponseBytes, controller);
        const responseHeaders = filterOperationalResponseHeaders(response.headers);
        return { bytes, mediaType, sourceUrl: url.toString(), statusCode: response.status, responseHeaders };
      } catch (error) {
        if (controller.signal.aborted && !(error instanceof SafeHttpError)) {
          throw new SafeHttpError('FETCH_TIMEOUT', 'Source response body timed out');
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
