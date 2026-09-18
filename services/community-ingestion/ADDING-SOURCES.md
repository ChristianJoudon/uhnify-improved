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

### An item's own page — `detail`

```jsonc
"followDetails": true,                    // the default; false means the list page says everything
"detailLinkSelector": "li.card h2 a",     // which links to follow (same host, de-duplicated, at most polling.maxPages)
"selectors": { …,
  "detail": {
    "location": "p:has(> strong:contains('Location'))",   // a venue block is read as lines; its label and "Get directions" are dropped
    "time": "p.event-time", "date": "p.event-start-date", "description": "div.about",
    "labels": { "time": "Time", "location": "Venue" }      // or labelled lines anywhere on that page
  } }
```

What the list row says wins; its own page fills what the row left out — the
venue, the time, the description, even the date — and outranks
`defaultLocation` and the page-level `…From` fallbacks. With no `detail`
selectors at all, a followed page's schema.org Event (JSON-LD or microdata)
still fills the gaps.

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

## What the reader does without being told

- **Dates.** Every written form above, plus: a weekday beside a date is
  checked against it — it *corrects* a year nobody wrote ("Sunday, November
  16" in last year's post is last year's) and *flags* a contradiction the
  publisher wrote ("Saturday, October 18, 2026") for a schedule check; "every
  Friday through December 18", "Saturdays in October", "Mondays, Sept 14 –
  Oct 26" are series with an end, written out to it; in a dated post (RSS,
  `prose`) "this Saturday" and "tomorrow" are read against the post's date.
- **Times.** "10a–2p", "6.30pm", "9 a.m.–noon", "doors 6, show 7" (the show),
  "all day"; a bare "6-8" only where the text is known to be a time (a
  `time` element, a `Time:` label, a schedule's row header).
- **Machine dates first.** A `<time datetime>` in an item is believed before
  its prose; schema.org is read as JSON-LD *and* microdata, and a malformed
  JSON-LD block (trailing commas, comments) is repaired rather than skipped.
- **Text.** A page that is not UTF-8 is decoded by its declared charset or
  as Windows-1252 instead of failing the run; text decoded once too often
  ("KÅ«hiÅ") is put back word by word; `<br>` and block ends are word
  breaks; `3<sup>rd</sup>` stays "3rd".
- **Titles.** SHOUTING is lowered with initials kept ("KCC 5K Fun Run & BBQ
  with DJ Anuhea"), a date tacked on the end is cut, wrapping quotes go. The
  item's key is made from the title as written, so polishing never re-keys.
  Every start is written on Kauaʻi's clock, whatever offset the feed used.

## What a run reports

| Warning | Means | Read is |
|---|---|---|
| `SELECTOR_MATCHED_NOTHING` | the item selector found no rows — the markup changed | PARTIAL |
| `NO_DATES_READ` | rows matched, none had a readable date or rule | PARTIAL |
| `READ_FROM_STRUCTURED_DATA` | …so the page's schema.org was read meanwhile | — |
| `PAGE_PARSE_FAILED` | a page could not be parsed at all | PARTIAL |
| `WEEKDAY_DISAGREES` | an event's weekday and date contradict; queued for a schedule check | complete |
| `TIMES_LOOK_SHIFTED` | most events start between midnight and 5 AM — see `timestampsAreLocal` | complete |
| `JUNK_TITLES_DROPPED` | rows titled "Read more", "Events"… were dropped | complete |
| `SENSITIVE_WITHHELD` | recovery meetings were not collected | complete |

An empty calendar — rows that are simply past, or none at all on a page
whose selector still matches — is a complete read with no warning. That is
the difference a silent zero hides.

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
