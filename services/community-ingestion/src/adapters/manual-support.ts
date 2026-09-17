import { z } from 'zod';
import type {
  ExtractResult,
  ExtractedItem,
  FetchArtifactInput,
  PlannedRequest,
  SourceAdapter,
  SourceDefinition,
} from '../contracts.js';

const SupportSubtypeSchema = z.enum([
  'addiction_recovery',
  'family_addiction_support',
  'mental_health_peer',
  'mental_health_family',
  'dementia_caregiver',
]);

const ReviewFlagSchema = z.enum([
  'MANUAL_SOURCE_CAPTURE',
  'PARTIAL_SOURCE_SNAPSHOT',
  'SOURCE_SCHEDULE_CHANGES_FREQUENTLY',
  'SOURCE_DATE_ANOMALY',
  'SOURCE_CONFLICT_REVIEW',
  'SOURCE_PERMISSION_EVIDENCE_REQUIRED',
  'OLDER_LOCATION_EVIDENCE',
  'REGISTRATION_REQUIRED',
  'CONFIRM_BEFORE_ATTENDING',
  'ONLINE_ACCESS_WITHHELD',
]);

const HttpsSourceUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'sourceUrl must use HTTPS' });
  }
  if (url.username || url.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'sourceUrl must not contain credentials' });
  }
});

const SupportListingSchema = z.object({
  sourceItemKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  groupKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(200),
  supportSubtype: SupportSubtypeSchema,
  recurrenceLabel: z.string().trim().min(1).max(160),
  timeZone: z.literal('Pacific/Honolulu'),
  locationLabel: z.string().trim().min(1).max(300).optional(),
  formatLabels: z.array(z.string().trim().min(1).max(80)).max(20),
  reviewFlags: z.array(ReviewFlagSchema).max(10).optional(),
}).strict();

export const ManualSupportSnapshotSchema = z.object({
  schemaVersion: z.literal('support-snapshot.v1'),
  sourceId: z.string().regex(/^SEN-[0-9]{3}$/),
  sourceUrl: HttpsSourceUrlSchema,
  verifiedAt: z.string().datetime({ offset: true }),
  completeness: z.enum(['COMPLETE', 'PARTIAL']),
  reviewFlags: z.array(ReviewFlagSchema).min(1).max(10),
  listings: z.array(SupportListingSchema).min(1).max(500),
}).strict().superRefine((snapshot, context) => {
  const hasPartialFlag = snapshot.reviewFlags.includes('PARTIAL_SOURCE_SNAPSHOT');
  if (snapshot.completeness === 'PARTIAL' && !hasPartialFlag) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewFlags'],
      message: 'PARTIAL snapshots must carry PARTIAL_SOURCE_SNAPSHOT',
    });
  }
  if (snapshot.completeness === 'COMPLETE' && hasPartialFlag) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewFlags'],
      message: 'COMPLETE snapshots must not carry PARTIAL_SOURCE_SNAPSHOT',
    });
  }

  const itemKeys = new Set<string>();
  const groupFacts = new Map<string, { name: string; supportSubtype: z.infer<typeof SupportSubtypeSchema> }>();
  for (const [index, listing] of snapshot.listings.entries()) {
    if (itemKeys.has(listing.sourceItemKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['listings', index, 'sourceItemKey'],
        message: `Duplicate sourceItemKey ${listing.sourceItemKey}`,
      });
    }
    itemKeys.add(listing.sourceItemKey);

    const existing = groupFacts.get(listing.groupKey);
    if (existing && (existing.name !== listing.name || existing.supportSubtype !== listing.supportSubtype)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['listings', index, 'groupKey'],
        message: `Listings for groupKey ${listing.groupKey} must agree on name and supportSubtype`,
      });
    } else if (!existing) {
      groupFacts.set(listing.groupKey, {
        name: listing.name,
        supportSubtype: listing.supportSubtype,
      });
    }
  }
});

type ManualSupportSnapshot = z.infer<typeof ManualSupportSnapshotSchema>;
type SupportListing = z.infer<typeof SupportListingSchema>;

const PROHIBITED_FIELD_NAMES = new Set([
  'attendee',
  'attendeeIdentity',
  'attendeeName',
  'attendees',
  'contact',
  'contactEmail',
  'contactName',
  'contactPhone',
  'email',
  'facilitator',
  'facilitatorName',
  'hostName',
  'joinUrl',
  'meetingId',
  'memberName',
  'onlineAccess',
  'participant',
  'participantName',
  'participants',
  'passcode',
  'password',
  'phone',
  'registrationContact',
  'rsvp',
  'zoomId',
  'zoomLink',
  'zoomUrl',
]);

const PROHIBITED_STRING_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /(?:https?:\/\/|\b)[a-z0-9.-]*zoom\.us(?:\/|\b)/i, message: 'Zoom URLs are prohibited' },
  { pattern: /\b(?:zoom|meeting)\s*(?:id|link)\b/i, message: 'online meeting identifiers are prohibited' },
  { pattern: /\b(?:passcode|password)\b/i, message: 'online meeting credentials are prohibited' },
  { pattern: /\bmailto:|\btel:/i, message: 'personal contact links are prohibited' },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, message: 'email addresses are prohibited' },
  {
    pattern: /(?:^|\D)(?:\+?1[\s().-]*)?(?:\(?[2-9]\d{2}\)?[\s().-]*)?[2-9]\d{2}[\s.-]*\d{4}(?:\D|$)/,
    message: 'phone numbers are prohibited',
  },
];

const PROHIBITED_LISTING_URL = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i;

const assertPrivacySafe = (value: unknown, path = '$'): void => {
  if (typeof value === 'string') {
    for (const prohibited of PROHIBITED_STRING_PATTERNS) {
      if (prohibited.pattern.test(value)) throw new Error(`${prohibited.message} at ${path}`);
    }
    if (path !== '$.sourceUrl' && PROHIBITED_LISTING_URL.test(value)) {
      throw new Error(`URLs and private access links are prohibited at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPrivacySafe(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (PROHIBITED_FIELD_NAMES.has(key)) throw new Error(`Prohibited privacy field ${key} at ${path}`);
    assertPrivacySafe(entry, `${path}.${key}`);
  }
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const mergedReviewFlags = (snapshot: ManualSupportSnapshot, listing?: SupportListing): string[] =>
  unique([...snapshot.reviewFlags, ...(listing?.reviewFlags ?? [])]);

const manualEvidence = (index: number, name: string): ExtractedItem['evidence'] => [{
  locatorKind: 'manual_field',
  locator: `$.listings[${index}]`,
  excerpt: name,
}];

const groupItems = (snapshot: ManualSupportSnapshot): ExtractedItem[] => {
  const grouped = new Map<string, Array<{ listing: SupportListing; index: number }>>();
  snapshot.listings.forEach((listing, index) => {
    const entries = grouped.get(listing.groupKey) ?? [];
    entries.push({ listing, index });
    grouped.set(listing.groupKey, entries);
  });

  return [...grouped.entries()].map(([groupKey, entries]) => {
    const first = entries[0];
    if (!first) throw new Error(`Group ${groupKey} has no listings`);
    const recurrenceLabels = unique(entries.map(({ listing }) => listing.recurrenceLabel));
    const locationLabels = unique(entries.flatMap(({ listing }) => listing.locationLabel ? [listing.locationLabel] : []));
    const formatLabels = unique(entries.flatMap(({ listing }) => listing.formatLabels));
    const reviewFlags = unique(entries.flatMap(({ listing }) => mergedReviewFlags(snapshot, listing)));
    const shared = {
      title: first.listing.name,
      listingType: 'support_group',
      supportSubtype: first.listing.supportSubtype,
      recurrenceLabels,
      locationLabels,
      formatLabels,
      sourceUrl: snapshot.sourceUrl,
      verifiedAt: snapshot.verifiedAt,
      reviewFlags,
    };
    return {
      sourceItemKey: `group:${groupKey}`,
      canonicalSourceUrl: snapshot.sourceUrl,
      entityHint: 'group',
      rawFields: { groupKey, ...shared },
      normalizedFields: shared,
      evidence: manualEvidence(first.index, first.listing.name),
    };
  });
};

const eventItems = (snapshot: ManualSupportSnapshot): ExtractedItem[] => snapshot.listings.map((listing, index) => {
  const shared = {
    title: listing.name,
    listingType: 'support_group',
    supportSubtype: listing.supportSubtype,
    recurrenceLabel: listing.recurrenceLabel,
    timeZone: listing.timeZone,
    ...(listing.locationLabel ? { location: listing.locationLabel } : {}),
    formatLabels: listing.formatLabels,
    sourceUrl: snapshot.sourceUrl,
    verifiedAt: snapshot.verifiedAt,
    reviewFlags: mergedReviewFlags(snapshot, listing),
    realityStatus: 'SCHEDULED',
  };
  return {
    sourceItemKey: `event:${listing.sourceItemKey}`,
    canonicalSourceUrl: snapshot.sourceUrl,
    entityHint: 'event',
    rawFields: { groupKey: listing.groupKey, ...shared },
    normalizedFields: shared,
    evidence: manualEvidence(index, listing.name),
    explicitRealityHint: 'SCHEDULED',
  };
});

const validatedSnapshot = (input: FetchArtifactInput, source: SourceDefinition): ManualSupportSnapshot => {
  if (source.adapterKind !== 'MANUAL_CLIP') {
    throw new Error(`Manual support adapter cannot run source ${source.id} (${source.adapterKind})`);
  }
  if (!input.mediaType.toLowerCase().startsWith('application/json')) {
    throw new Error('Manual support snapshots must use application/json');
  }
  if (input.statusCode !== 200) throw new Error('Manual support snapshots require status code 200');

  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  const untrusted: unknown = JSON.parse(decoded);
  assertPrivacySafe(untrusted);
  const snapshot = ManualSupportSnapshotSchema.parse(untrusted);

  if (snapshot.sourceId !== source.id) {
    throw new Error(`Snapshot source ${snapshot.sourceId} does not match ${source.id}`);
  }
  if (snapshot.sourceUrl !== input.sourceUrl) {
    throw new Error('Snapshot sourceUrl must match the artifact sourceUrl');
  }
  return snapshot;
};

export class ManualSupportAdapter implements SourceAdapter {
  readonly kind = 'MANUAL_CLIP' as const;

  async planRequests(_source: SourceDefinition): Promise<PlannedRequest[]> {
    return [];
  }

  async prepareArtifactForStorage(input: FetchArtifactInput, source: SourceDefinition): Promise<Uint8Array> {
    const snapshot = validatedSnapshot(input, source);
    return new TextEncoder().encode(JSON.stringify(snapshot));
  }

  async extract(input: FetchArtifactInput, source: SourceDefinition): Promise<ExtractResult> {
    const snapshot = validatedSnapshot(input, source);
    const items = [...groupItems(snapshot), ...eventItems(snapshot)];
    return {
      items,
      completeness: snapshot.completeness,
      warnings: snapshot.reviewFlags
        .filter(flag => flag !== 'MANUAL_SOURCE_CAPTURE')
        .map(flag => ({ code: flag, message: `Manual support snapshot requires review: ${flag}` })),
      metrics: {
        discovered: snapshot.listings.length,
        emitted: items.length,
        rejected: 0,
      },
    };
  }

  stableItemKey(item: ExtractedItem): string {
    return item.sourceItemKey;
  }
}
