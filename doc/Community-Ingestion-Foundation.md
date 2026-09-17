# MatchBook community ingestion foundation

This slice creates a governed intake lane for community-event sources without
changing MatchBook's existing public calendar. The existing `Events` and
`Clubs` collections remain the public legacy projection. The ingestion service
does not import or write either collection.

## Safety boundary

The implemented data flow stops at a review candidate:

```text
registered source
  -> immutable content-addressed artifact
  -> immutable source observation and evidence pointers
  -> normalized internal candidate
  -> curator review (next slice)
  -> canonical/public event (not implemented in this slice)
```

All 19 production sources in `app/private/community-sources.v1.json` remain
disabled. The 14 general community sources begin with
`permission: PROBE_REQUIRED`. The five sensitive support-schedule sources use
`permission: MANUAL_ONLY` and may ingest only a sanitized, operator-supplied
snapshot. An endpoint responding is not permission to automate collection.
Automated execution additionally requires `AUTOMATED_ALLOWED`, and the registry
validator refuses an enabled source that has not reached that permission state.

The HTTP boundary rejects non-HTTPS URLs, URL credentials, unlisted hosts and
redirects, private or loopback network destinations, unexpected media types,
oversized responses, excess redirects, and timeouts. It records retry guidance
for rate-limited responses but does not automatically activate or schedule any
source.

## Internal persistence

The Meteor server owns the MongoDB collection indexes and exposes only a
sanitized, admin-only operational view. Raw bytes, response headers,
observations, evidence excerpts, and normalized candidate payloads are never
published to browser clients.

| Collection | Purpose | Browser visibility |
| --- | --- | --- |
| `community_sources` | Versioned source policy and readiness | Sanitized admin fields only |
| `source_policy_assessments` | Append-only source-policy decisions | Server only |
| `source_runs` | Immutable run outcome and reconciliation totals | Sanitized admin fields only |
| `source_cursors` | Per-source continuation state for a future scheduler | Server only |
| `fetch_artifacts` | Hash, origin, response metadata, protected storage path | Server only |
| `parse_runs` | Artifact and parser-version replay identity | Server only |
| `source_observations` | Immutable allowlisted facts and evidence pointers | Server only |
| `field_assertions` | Field-level provenance decisions | Server only |
| `ingestion_candidates` | Internal normalized proposals for later review | Summary/status only for admins |
| `source_entity_keys` | Stable publisher identifiers | Server only |
| `review_items` | Future curator work queue | Server only |
| `source_health` | Operational source status | Sanitized admin fields only |

## Local verification

The standalone service uses Node.js 20 or newer:

```bash
cd services/community-ingestion
npm ci
npm run validate-registry
npm run typecheck
npm test
```

The replay tests use a synthetic fixture and a temporary artifact directory.
They perform no live network requests and do not connect to the app's MongoDB.
They prove that identical bytes do not duplicate artifacts, observations, or
candidates; factual changes append history; parser upgrades can reprocess the
same artifact; and fields outside a source's allowlist are discarded.

### Sensitive support snapshots

The protected snapshot adapter covers the official Kauaʻi AA, NA Hawaiʻi,
Al-Anon Hawaiʻi, NAMI Kauaʻi, and Alzheimer’s Association Hawaiʻi schedule
pages. It creates private `support_group` group and recurring-event candidates;
it never creates or edits public `Clubs` or `Events` records. Online access
links, meeting IDs and passcodes, personal contacts, and participant identities
are rejected before candidate creation. Evidence excerpts are omitted from this
sensitive lane. Support participation is also excluded from public profile
interests and accepted-friend activity.

Running the five checked-in snapshots requires an explicit database and an
operator confirmation:

```bash
cd services/community-ingestion
MONGO_URL='mongodb://127.0.0.1:3001/meteor' \
  MATCHBOOK_ARTIFACT_ROOT="$PWD/.artifacts/support" \
  npx tsx src/cli.ts ingest-support-snapshots --confirm-sensitive-manual
```

The current fixtures yield 52 group candidates and 85 recurring-meeting
candidates. Replaying identical snapshots is idempotent. Every candidate remains
in the sensitive human-review lane; none is automatically publishable. The
Alzheimer’s Association source additionally remains blocked on retained reuse-
permission evidence.

## Before enabling a real source

A source remains off until all of the following evidence exists:

1. Collection and republication policy have been reviewed and recorded.
2. Exact endpoints, redirect hosts, field authority, and rate limits are
   approved.
3. Parser fixtures cover valid, sparse, malformed, all-day, timezone, and
   cancellation cases.
4. A dark run has been compared against at least 20 live listings.
5. A named steward owns failures, review, and source changes.
6. Seven consecutive days of clean, reconciled dark runs are retained.

The next bounded implementation is the curator review and promotion workflow,
followed by one frozen Kauaʻi Festivals fixture adapter. Live requests and
scheduled collection remain gated on source-policy approval.
