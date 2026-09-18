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
  /**
   * One endpoint asked several times: once per day, per month, or per listed
   * value. The variable is written {NAME} in the URL or body, or {NAME|M-D-YYYY}
   * to say how a date is spelled there.
   */
  expand: z.object({
    variable: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    days: z.number().int().min(1).max(366).optional(),
    months: z.number().int().min(1).max(24).optional(),
    values: z.array(z.string().min(1)).min(1).max(100).optional(),
  }).strict().optional(),
}).strict();

/** A dotted path into a record ("venue.name", "dates.0.date"); a list is tried in order. */
const FieldPathSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const RecordFilterSchema = z.object({
  field: z.string().min(1),
  pattern: z.string().min(1),
}).strict();

/**
 * How to read event records out of a JSON document whose field names are the
 * publisher's own. With this a new JSON API is a register entry, not code.
 */
const JsonRecordsSchema = z.object({
  /** Where the records are: "events", "data.paginatedEvents.collection", "*" for an object's values, "*.*" for an object of arrays. */
  path: z.string().min(1).optional(),
  /** The JSON is inside an HTML page: a <script> by selector, or the text after a marker such as "window.__BOOTSTRAP_STATE__ =". */
  htmlJson: z.object({
    selector: z.string().min(1).optional(),
    marker: z.string().min(1).optional(),
    attribute: z.string().min(1).optional(),
  }).strict().optional(),
  fields: z.object({
    id: FieldPathSchema.optional(),
    title: FieldPathSchema,
    /** A whole date-time in any written form, or epoch seconds/milliseconds. */
    start: FieldPathSchema.optional(),
    end: FieldPathSchema.optional(),
    /** A date alone, with `time` beside it. */
    date: FieldPathSchema.optional(),
    endDate: FieldPathSchema.optional(),
    time: FieldPathSchema.optional(),
    endTime: FieldPathSchema.optional(),
    /** Text to search for the date when no field carries one (a blog post's body). */
    prose: FieldPathSchema.optional(),
    /** When the record was published: a prose date earlier than this is not the event's. */
    published: FieldPathSchema.optional(),
    /** Every listed path that has a value, joined with commas. */
    location: z.array(z.string().min(1)).min(1).optional(),
    description: FieldPathSchema.optional(),
    url: FieldPathSchema.optional(),
    categories: FieldPathSchema.optional(),
    status: FieldPathSchema.optional(),
    /** Text that says how the record repeats ("Every 1st Friday of the Month"). */
    recurrence: FieldPathSchema.optional(),
  }).strict(),
  /** A record whose `recurrence` reads as a rule is written out for this many weeks from its start. */
  recurrenceWeeks: z.number().int().min(1).max(26).optional(),
  urlPrefix: z.string().url().optional(),
  include: RecordFilterSchema.optional(),
  exclude: RecordFilterSchema.optional(),
}).strict();

/**
 * How to read events out of a server-rendered page: which element is one
 * event, and where in it (or before it) the title, date and place are. With
 * no `title`, the item's text is the title with the date taken out — which
 * is how a church bulletin line reads.
 */
const HtmlSelectorsSchema = z.object({
  item: z.string().min(1),
  title: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
  dateAttr: z.string().min(1).optional(),
  time: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  link: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  /** The nearest element BEFORE the item that carries its date, month or weekday — a heading over a group of lines. */
  dateFrom: z.string().min(1).optional(),
  /** A page-level element whose text names the year ("2026 Racing Schedule"). */
  yearFrom: z.string().min(1).optional(),
  /** Undated items under a weekday heading ("Tuesday"), or carrying "every Friday", repeat weekly for this many weeks. */
  weeklyWeeks: z.number().int().min(1).max(26).optional(),
  include: z.string().min(1).optional(),
  exclude: z.string().min(1).optional(),
  /** Stop at the first item or heading that matches ("Previous Concerts"). */
  stopAt: z.string().min(1).optional(),
  defaultTitle: z.string().min(1).optional(),
  defaultLocation: z.string().min(1).optional(),
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
  /** The key of the array of event records ("events", "Value", "upcoming"),
      or a description of the publisher's own shape for a bespoke parser. */
  eventSelector: z.string().min(1),
  /** Some publishers write Kauaʻi wall-clock times with a "Z" on the end
      (AlohaCalendar, CitySpark); read those as Pacific/Honolulu, not UTC. */
  timestampsAreLocal: z.boolean().optional(),
  records: JsonRecordsSchema.optional(),
}).strict();

const IcsConfigSchema = z.object({
  kind: z.literal('ICS'),
  materializationDays: z.number().int().min(1).max(366),
}).strict();

const RssConfigSchema = z.object({
  kind: z.literal('RSS_ATOM'),
  identityField: z.enum(['guid', 'link']),
  /** Only items whose title or categories match (a blog that also announces events). */
  include: z.string().min(1).optional(),
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
  selectors: HtmlSelectorsSchema.optional(),
  /** false: the list page says everything; do not fetch the pages it links to. */
  followDetails: z.boolean().optional(),
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
