# Adding a source

A source is an entry in `app/private/community-sources.v1.json`. Since
September 2026 almost every site can be read by *describing* it there; new
parser code is for the rare platform nothing below covers.

All commands run from `services/community-ingestion`.

## The loop

```bash
npx tsx src/cli.ts probe 'https://example.org/events/'        # may we, is anything there, how would we read it
npx tsx src/cli.ts dry-run proposals/example-org.json          # fetch + parse as a run would; stores nothing
npx tsx src/cli.ts dry-run entry.json --save-fixture=test/sites/example-org   # keep it as a test
npx tsx src/cli.ts adopt example-org --steward='Your Name'     # into the register, under your name
MONGO_URL=… npx tsx src/cli.ts discover --limit=25             # probe the organisers' sites our own data links to
```

`probe` checks `robots.txt` for our user-agent, reads the site's terms of use
for a prohibition on automated access, and tries, in order: The Events
Calendar's REST API, calendar feeds (linked `.ics`, embedded or script-drawn
Google Calendars, CalendarWiz), RSS/Atom, schema.org `Event` on the page or
its event pages, and finally the page itself by inferring the repeated element
that carries its dates. Each candidate is run through the real adapter and
counted. A site that is ready leaves a proposal in `proposals/`.

**It never works around a refusal.** A 403 to a plain, identified request, a
bot challenge, or terms that forbid automated access end the probe with
`refused` / `not-permitted`. Those are the site's answer.

`adopt` is the one human step: the register's rule is that somebody puts
their name and the date to a source before it runs.

## Endpoint templates

| Placeholder | Becomes |
|---|---|
| `{START_DATE}` `{END_DATE}` | the polling window's edges, `YYYY-MM-DD` |
| `{DATE+N}` | N days from today on Kauaʻi |
| `{MONTH+N}` | the first of the month, N months on |
| `{…\|M-D-YYYY}` | any of the above spelled with `YYYY` `MM` `M` `DD` `D` |

An endpoint with `"expand": { "variable": "DAY", "days": 45 }` is asked once
per day with `{DAY}` / `{DAY|M-D-YYYY}` filled in; `"months": 3` once per
month; `"values": ["0","1"]` once per value. Every `COLLECTION` endpoint of a
source is fetched. A missing day or month is a partial read, not a failure;
every request failing is.

## `STATIC_JSON` with `records` — a publisher's own JSON

```jsonc
"adapterConfig": { "kind": "STATIC_JSON", "eventSelector": "what this is, in words",
  "timestampsAreLocal": true,           // their "13:00Z" means 1 PM on Kauaʻi
  "records": {
    "path": "data.events",              // "*" = an object's values or an array's items; "days.*.*" = object of arrays
    "htmlJson": { "marker": "window.__BOOTSTRAP_STATE__ =" },   // or { "selector": "script#data", "attribute": "data-x" }
    "fields": {
      "title": "title.rendered",        // a path, or a list of paths tried in order
      "start": "start_datetime",        // ISO, epoch s/ms, "2026-09-18 05:30 PM", or prose with a date in it
      "date": "dates.0.date", "time": "dates.0.startTime", "endTime": "dates.0.endTime",   // or date and clock apart (ms after midnight is understood)
      "prose": "content.rendered", "published": "date",         // a post that announces an event: first date not before the post
      "recurrence": "dates.0.dateString",                        // "Every 1st Friday of the Month"
      "location": ["venue.name", "address", "city"],           // every one that has a value, comma-joined
      "description": "excerpt", "url": "link", "id": "id", "categories": "category", "status": "status"
    },
    "recurrenceWeeks": 8,               // write a repeating record out this far
    "include": { "field": "area", "pattern": "kaua" }, "exclude": { "field": "title", "pattern": "^closed" },
    "urlPrefix": "https://example.org"
  } }
```

## `SOURCE_HTML` with `selectors` — a server-rendered page

```jsonc
"adapterConfig": { "kind": "SOURCE_HTML", "detailLinkSelector": "a", "sitemap": false, "followDetails": false,
  "selectors": {
    "item": "div.eventitem",            // one element per event — or per line
    "title": "h3",                      // omit it and the item's text, minus its date and time, is the title
    "date": "div.eventdate", "dateAttr": "datetime",
    "time": "span.eventtime", "location": "span.venue", "description": "p.summary", "link": "a.more", "category": ".tag",
    "dateFrom": "h2.month, h4",         // the nearest heading BEFORE the item that carries its date, month+year or weekday
    "yearFrom": "div.selectedmonth",    // a page-level element naming the year
    "weeklyWeeks": 8,                   // undated items under a weekday heading, or saying "every Friday", repeat this far
    "include": "kaua", "exclude": "food tour", "stopAt": "^Previous Concerts",
    "defaultTitle": "KAGRA Rodeo", "defaultLocation": "CJM Stables, Poʻipū",

    "titleFrom": "h1.show-title",       // the nearest element BEFORE the item that names it (a show over its dates)
    "timeFrom": "#start-time", "locationFrom": "p.venue", "descriptionFrom": "div.intro > p",   // said once on the page, for every item
    "titlePrefix": "Admission-free day: ",
    "titleLine": true,                  // the title is the item's first line
    "titleAfter": "\\s[-–—]\\s+",        // "<when> - <what>": cut there; the date is read from the first half
    "titleStrip": "^(?:SOLD OUT|POSTPONED)\\s*",   // leaves the title, becomes the status; the item keeps its key
    "locationPattern": "\\s@\\s*([^–—-]+)",   // a place written into the line: group 1
    "labels": { "location": "Where|Location", "date": "When", "time": "Time", "title": "Event" },   // labelled lines
    "dateRequired": true,               // the `date` element must hold a date (no falling back to a deadline in the prose)
    "dateFromWins": true,               // the heading's date is the date, whatever the item mentions
    "cellHeaders": true                 // item is a <td>: weekday/date from its column header, time from its row header
  } }
```

`labels`, `titleStrip`, `groupPath` + `dateFrom` (records in sections whose
heading carries the month and year) and `defaultLocation` exist on
`records` too. `embedSelector` (on `SOURCE_HTML` and `JSON_LD_HTML`) follows
a same-site `<iframe src>` that holds the real list.

A weekly series stored as one long run ("01/07/2026 to 12/31/2026", weekday
in the title) is written out as a series when `weeklyWeeks` is set. A run
that has opened and not closed ("Jan 8 – 31") stays in the read until it
closes. Where a `time` selector is given, the prose is not searched for a
clock.

Dates are read however they are typed — "Sunday, August 30, 2026", "Sept.
13th & 20th", "Oct 8–11", "9/20:", "26 Sep 2026" — and a missing year is the
nearest one that is not long past (`src/text-dates.ts`). Times likewise:
"3-6 PM", "9 a.m.-noon", "8:30-10:30am".

## `ICS`

`"exclude": "^No Service|Gallery Maintenance"` drops entries that are not
events. Recurrence is reckoned on Kauaʻi's wall clock: WEEKLY with BYDAY,
MONTHLY with an ordinal BYDAY ("1SU", "-1FR") or BYMONTHDAY, YEARLY, EXDATE,
and RECURRENCE-ID overrides replacing the occurrence they edit.

## `RSS_ATOM`

Items whose title or body names a date on or after the post's own are events
on that date; the rest are articles and are skipped. `"include": "event"`
keeps only items whose title or categories match.

## What is always true

- Recovery meetings (AA, NA, Al-Anon…) on a general calendar are never
  collected; the run records `SENSITIVE_WITHHELD`. Those come only from the
  fellowships' own lists, through the manual `SEN-` lane.
- "CANCELLED" / "postponed" in a title sets the event's status rather than
  dropping it.
- Only the fields in `fieldAllowlist` are stored from a record.
- `test/sites/<slug>/` (entry + captured pages + expected) is replayed by
  `sites.test.ts` with the clock set to the capture. Trim `pages.json` to a
  few events, then `dry-run entry.json --save-fixture=<dir> --expect-only`.
