import type {
  ExtractResult,
  FetchArtifactInput,
  ExtractedItem,
  PlannedRequest,
  SourceAdapter,
  SourceDefinition,
} from '../contracts.js';

type FixtureDocument = {
  items: Array<{
    id: string;
    title: string;
    start: string;
    location?: string;
    description?: string;
    phone?: string;
  }>;
};

export class SyntheticFixtureAdapter implements SourceAdapter {
  readonly kind = 'SYNTHETIC_FIXTURE' as const;

  async planRequests(source: SourceDefinition): Promise<PlannedRequest[]> {
    return source.endpoints.map(endpoint => ({ method: endpoint.method, url: endpoint.urlTemplate }));
  }

  async extract(input: FetchArtifactInput): Promise<ExtractResult> {
    const parsed = JSON.parse(new TextDecoder().decode(input.bytes)) as FixtureDocument;
    if (!Array.isArray(parsed.items)) throw new Error('Synthetic fixture must contain an items array');
    const items: ExtractedItem[] = parsed.items.map((item, index) => ({
      sourceItemKey: item.id,
      canonicalSourceUrl: input.sourceUrl,
      entityHint: 'event',
      rawFields: {
        id: item.id,
        title: item.title,
        start: item.start,
        ...(item.location ? { location: item.location } : {}),
        ...(item.description ? { description: item.description } : {}),
        ...(item.phone ? { phone: item.phone } : {}),
      },
      normalizedFields: {
        title: item.title.trim(),
        localStart: item.start,
        timeZone: 'Pacific/Honolulu',
        ...(item.location ? { location: item.location.trim() } : {}),
        realityStatus: 'SCHEDULED',
      },
      evidence: [{
        locatorKind: 'json_path',
        locator: `$.items[${index}]`,
        excerpt: item.title,
      }],
      explicitRealityHint: 'SCHEDULED',
    }));
    return {
      items,
      completeness: 'COMPLETE',
      warnings: [],
      metrics: { discovered: items.length, emitted: items.length, rejected: 0 },
    };
  }

  stableItemKey(item: ExtractedItem): string {
    return item.sourceItemKey;
  }
}
