# tools

Build-time scripts. **Outside `app/` on purpose** — Meteor bundles and executes
every file under `app/` except `public/`, `private/` and `tests/`, so a Node
script parked there runs as server code at boot and crashes the server.

```bash
cd tools && npm install     # once
```

## Refreshing the directory

`sync-register.mjs` is the one to use once a database exists.

```bash
node tools/sync-register.mjs <register.json> --dry-run   # show what would change
node tools/sync-register.mjs <register.json>             # apply
node tools/sync-register.mjs <register.json> --prune      # also remove withdrawn records
```

`MONGO_URL` defaults to Meteor's dev database. Set it to sync anywhere else.

It is re-runnable because every record is upserted on the publisher's own stable
id (`evt_5c98bcdcb178`, expanded to `evt_5c98bcdcb178@2026-08-02` for one
occurrence of a recurring listing). That means:

- a refresh **updates in place**, so a record keeps its `_id` and every
  membership, swipe and saved reference that points at it survives;
- a field the register **stops** publishing is removed rather than left stale,
  so a card stops drawing that row instead of showing an old price;
- `--prune` only ever removes records carrying this dataset's `importedFrom`.
  Anything a person created in the app has neither that nor a `sourceId` and is
  never a candidate;
- a database seeded before stable ids existed is **adopted** on the first run by
  matching natural keys, so an existing install migrates in place.

There is no size ceiling. This talks to Mongo directly.

## Cold start only

`import-register.mjs` writes `app/private/seed-kauai.json`, which the server
reads at boot *only when the collections are empty*. Both scripts share
`lib/transform.mjs`, so the seed and the sync can never disagree.

```bash
node tools/import-register.mjs <register.json> app/private/seed-kauai.json
```
