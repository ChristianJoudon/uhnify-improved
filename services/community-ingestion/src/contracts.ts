import { z } from 'zod';

export const AdapterKindSchema = z.enum([
  'TRIBE_REST',
  'WP_FILTERED_TRIBE',
  'STATIC_JSON',
  'ICS',
  'RSS_ATOM',
  'JSON_LD_HTML',
  'COUNTY_OPENCITIES',
  'SOURCE_HTML',
  'PDF_MONITOR',
  'SUBMISSION',
  'MANUAL_CLIP',
  'SYNTHETIC_FIXTURE',
]);

export const CollectionPermissionSchema = z.enum([
  'PROBE_REQUIRED',
  'AUTOMATED_ALLOWED',
  'MANUAL_ONLY',
  'PAUSED',
  'PROHIBITED',
]);

export const SourceTrustSchema = z.enum([
  'OFFICIAL_ORGANIZER',
  'OFFICIAL_VENUE',
  'GOVERNMENT_INSTITUTION',
  'PARTNER',
  'AGGREGATOR',
  'DIRECTORY',
  'COMMUNITY_SUBMISSION',
]);

export const SourceEndpointSchema = z.object({
  purpose: z.enum(['COLLECTION', 'HYDRATION', 'FALLBACK', 'DISCOVERY']),
  method: z.enum(['GET', 'POST']),
  urlTemplate: z.string().url(),
  headers: z.record(z.string()).optional(),
  bodyTemplate: z.unknown().optional(),
}).strict();

const TribeConfigSchema = z.object({
  kind: z.literal('TRIBE_REST'),
  categorySlug: z.string().min(1).optional(),
  perPage: z.number().int().min(1).max(100),
}).strict();

const WpFilteredTribeConfigSchema = z.object({
  kind: z.literal('WP_FILTERED_TRIBE'),
  taxonomySlug: z.string().min(1),
  batchSize: z.number().int().min(1).max(100),
}).strict();

const StaticJsonConfigSchema = z.object({
  kind: z.literal('STATIC_JSON'),
  eventSelector: z.string().min(1),
}).strict();

const IcsConfigSchema = z.object({
  kind: z.literal('ICS'),
  materializationDays: z.number().int().min(1).max(366),
}).strict();

const RssConfigSchema = z.object({
  kind: z.literal('RSS_ATOM'),
  identityField: z.enum(['guid', 'link']),
}).strict();

const JsonLdConfigSchema = z.object({
  kind: z.literal('JSON_LD_HTML'),
  detailLinkSelector: z.string().min(1),
}).strict();

const CountyConfigSchema = z.object({
  kind: z.literal('COUNTY_OPENCITIES'),
  calendarDiscoveryUrl: z.string().url(),
}).strict();

const HtmlConfigSchema = z.object({
  kind: z.literal('SOURCE_HTML'),
  detailLinkSelector: z.string().min(1),
  sitemap: z.boolean().default(false),
}).strict();

const PdfConfigSchema = z.object({
  kind: z.literal('PDF_MONITOR'),
  changeReviewOnly: z.literal(true),
}).strict();

const SubmissionConfigSchema = z.object({
  kind: z.literal('SUBMISSION'),
}).strict();

const ManualConfigSchema = z.object({
  kind: z.literal('MANUAL_CLIP'),
}).strict();

const SyntheticConfigSchema = z.object({
  kind: z.literal('SYNTHETIC_FIXTURE'),
}).strict();

export const AdapterConfigSchema = z.discriminatedUnion('kind', [
  TribeConfigSchema,
  WpFilteredTribeConfigSchema,
  StaticJsonConfigSchema,
  IcsConfigSchema,
  RssConfigSchema,
  JsonLdConfigSchema,
  CountyConfigSchema,
  HtmlConfigSchema,
  PdfConfigSchema,
  SubmissionConfigSchema,
  ManualConfigSchema,
  SyntheticConfigSchema,
]);

export const HttpPolicySchema = z.object({
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedRedirectHosts: z.array(z.string().min(1)).default([]),
  allowedMediaTypes: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().min(100).max(120_000),
  maxResponseBytes: z.number().int().min(1).max(50_000_000),
  maxRedirects: z.number().int().min(0).max(5),
  minimumDelayMs: z.number().int().min(0).max(120_000),
}).strict();

export const PollingPolicySchema = z.object({
  intervalMinutes: z.number().int().min(15).max(43_200),
  jitterPercent: z.number().min(0).max(30),
  lookBackDays: z.number().int().min(0).max(365),
  lookAheadDays: z.number().int().min(1).max(366),
  maxPages: z.number().int().min(1).max(500),
  maxItems: z.number().int().min(1).max(10_000),
}).strict();

const SECRET_QUERY_NAMES = new Set([
  'access_token',
  'api_key',
  'key',
  'password',
  'secret',
  'token',
]);

const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
]);

export const SourceDefinitionSchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1),
  publisherName: z.string().min(1),
  publisherUrl: z.string().url(),
  tier: z.enum(['A', 'B', 'C', 'D', 'E', 'X']),
  adapterKind: AdapterKindSchema,
  adapterConfig: AdapterConfigSchema,
  endpoints: z.array(SourceEndpointSchema).min(1),
  trust: SourceTrustSchema,
  permission: CollectionPermissionSchema,
  contentKinds: z.array(z.enum(['event', 'group', 'organization', 'venue'])).min(1),
  polling: PollingPolicySchema,
  httpPolicy: HttpPolicySchema,
  parser: z.object({
    parserId: z.string().min(1),
    parserVersion: z.string().min(1),
    fixtureVersion: z.string().min(1),
  }).strict(),
  fieldAllowlist: z.array(z.string().min(1)).min(1),
  authorityByField: z.record(SourceTrustSchema),
  enabled: z.boolean(),
  nextRunAt: z.string().datetime(),
  lastVerifiedAt: z.string().datetime(),
  steward: z.string().min(1),
}).strict().superRefine((source, context) => {
  if (source.adapterKind !== source.adapterConfig.kind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['adapterConfig', 'kind'],
      message: 'adapterConfig.kind must match adapterKind',
    });
  }

  if (source.enabled && source.permission !== 'AUTOMATED_ALLOWED') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enabled'],
      message: 'Only an AUTOMATED_ALLOWED source may be enabled',
    });
  }

  const allowedHosts = new Set([
    ...source.httpPolicy.allowedHosts,
    ...source.httpPolicy.allowedRedirectHosts,
  ]);
  for (const [index, endpoint] of source.endpoints.entries()) {
    const url = new URL(endpoint.urlTemplate.replaceAll('{YYYY-MM-DD}', '2026-08-08')
      .replaceAll('{N}', '1')
      .replaceAll('{RESOLVED_ID}', '1')
      .replaceAll('{COMMA_SEPARATED_IDS}', '1')
      .replaceAll('{CALENDAR_ID}', 'calendar')
      .replaceAll('{CONTENT_ID}', 'content')
      .replaceAll('{ENCODED_ITEM_DATETIME}', '2026-08-08')
      .replaceAll('{MAIN_CONTENT_ID}', 'main'));
    if (url.username || url.password) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoints', index, 'urlTemplate'],
        message: 'Endpoint URLs must not contain credentials',
      });
    }
    for (const name of url.searchParams.keys()) {
      if (SECRET_QUERY_NAMES.has(name.toLowerCase())) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints', index, 'urlTemplate'],
          message: `Endpoint URLs must not contain secret query parameter ${name}`,
        });
      }
    }
    for (const name of Object.keys(endpoint.headers ?? {})) {
      if (SECRET_HEADER_NAMES.has(name.toLowerCase())) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints', index, 'headers', name],
          message: `Endpoint headers must not contain secret header ${name}`,
        });
      }
    }
    if (url.protocol !== 'https:') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoints', index, 'urlTemplate'],
        message: 'Collection endpoints must use HTTPS',
      });
    }
    if (!allowedHosts.has(url.hostname)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoints', index, 'urlTemplate'],
        message: `Endpoint host ${url.hostname} is not allowlisted`,
      });
    }
  }
});

export const SourceRegistrySchema = z.object({
  registryVersion: z.string().min(1),
  sources: z.array(SourceDefinitionSchema).min(1),
}).strict();

export type SourceDefinition = z.infer<typeof SourceDefinitionSchema>;
export type SourceRegistry = z.infer<typeof SourceRegistrySchema>;
export type HttpPolicy = z.infer<typeof HttpPolicySchema>;

export function validateRegistry(input: unknown): SourceRegistry {
  const registry = SourceRegistrySchema.parse(input);
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const source of registry.sources) {
    if (ids.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    if (slugs.has(source.slug)) throw new Error(`Duplicate source slug: ${source.slug}`);
    ids.add(source.id);
    slugs.add(source.slug);
  }
  return registry;
}

export type PlannedRequest = {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

export type FetchArtifactInput = {
  bytes: Uint8Array;
  mediaType: string;
  sourceUrl: string;
  statusCode: number;
  responseHeaders: Record<string, string>;
};

export type ExtractedItem = {
  sourceItemKey: string;
  canonicalSourceUrl: string;
  entityHint: 'event' | 'group' | 'organization' | 'venue';
  rawFields: Record<string, unknown>;
  normalizedFields: Record<string, unknown>;
  evidence: Array<{
    locatorKind: 'json_path' | 'ical_property' | 'css_selector' | 'pdf_page' | 'manual_field';
    locator: string;
    excerpt?: string;
  }>;
  explicitRealityHint?: 'SCHEDULED' | 'POSTPONED' | 'CANCELLED';
};

export type ExtractResult = {
  items: ExtractedItem[];
  completeness: 'COMPLETE' | 'PARTIAL';
  warnings: Array<{ code: string; message: string }>;
  metrics: { discovered: number; emitted: number; rejected: number };
};

export interface SourceAdapter {
  readonly kind: SourceDefinition['adapterKind'];
  planRequests(source: SourceDefinition): Promise<PlannedRequest[]>;
  /**
   * Validate and, when necessary, canonicalize bytes before the runtime is
   * allowed to persist them. The runtime requires this hook for SEN-* sources.
   */
  prepareArtifactForStorage?(input: FetchArtifactInput, source: SourceDefinition): Promise<Uint8Array>;
  extract(input: FetchArtifactInput, source: SourceDefinition): Promise<ExtractResult>;
  stableItemKey(item: ExtractedItem): string;
}

export function assertAdapter(adapter: SourceAdapter, source: SourceDefinition): void {
  if (adapter.kind !== source.adapterKind) {
    throw new Error(`Adapter ${adapter.kind} cannot run source ${source.id} (${source.adapterKind})`);
  }
  for (const method of ['planRequests', 'extract', 'stableItemKey'] as const) {
    if (typeof adapter[method] !== 'function') throw new Error(`Adapter is missing ${method}`);
  }
  if (adapter.prepareArtifactForStorage !== undefined
    && typeof adapter.prepareArtifactForStorage !== 'function') {
    throw new Error('Adapter prepareArtifactForStorage must be a function');
  }
}
