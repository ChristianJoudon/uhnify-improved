# Production environment

What a production MatchBook process needs from its environment, and what goes
wrong without each piece. The bundle is a plain Node program (`meteor build`,
then `node main.js` inside the bundle), and everything below is read either
from the process environment or from the settings file.

The process refuses to start on the development settings.
`app/imports/startup/server/productionGuard.js` is the first import in
`app/server/main.js` and stops a production process that has been handed
`config/settings.development.json`, because the next thing the server would do
with that file is create `admin@foo.com / changeme` as the administrator.

## Environment

| Variable | Value | Why it is needed |
| --- | --- | --- |
| `ROOT_URL` | `https://<host>` | The site's own address. Meteor uses it for every absolute link, and `securityHeaders.js` sends `Strict-Transport-Security` only when it begins with `https://`. Set it to plain http and there is no HSTS; leave it unset and links point at `localhost`. |
| `PORT` | the port the proxy forwards to | Where the Node process listens. The reverse proxy owns 443; the app never does. |
| `MONGO_URL` | `mongodb://…/matchbook` | The database. Unset, the bundle does not start; pointed at the development database, it seeds and migrates that. |
| `MONGO_OPLOG_URL` | `mongodb://…/local` (a user with oplog read access) | Without it Meteor falls back to poll-and-diff: every live query is re-run after each write this process makes and every ten seconds regardless, so database load grows with every open connection, and writes from anywhere else (a second instance, a shell, an ingestion job) show up to ten seconds late. |
| `MAIL_URL` | `smtps://user:pass@smtp-host:465` | Outbound mail. Needed from phase 6, when posting requires a verified email address and password reset goes out by mail; until then it is unset and Meteor prints would-be mail to the log. |
| `METEOR_SETTINGS` | the JSON of a production settings file | Or start with `--settings <file>`. Holds the production accounts and the seed data. Never the development file: see the guard above. |
| `HTTP_FORWARDED_COUNT` | `1` | Exactly one reverse proxy stands between the internet and the process, so trust exactly one `X-Forwarded-For` hop. **Without it every visitor is the proxy's address**, and the two per-address rate limits below become site-wide: the thirty-first sign-in on the whole site within a minute is refused, and because a refused session resume makes the browser discard its stored token, that visitor is logged out rather than delayed. With a value larger than the real number of proxies, a visitor can forge the address instead and the limits stop meaning anything. |
| `NODE_ENV` | `production` | What the guard, the minifier and several packages key their production behaviour on. |

## Settings an operator can change

Four values in the settings file (`METEOR_SETTINGS` or `--settings`), all
optional. Each is read when it is used, so a change takes effect at the next
restart and nothing has to be rebuilt. `app/.deploy/settings.sample.json`
carries them at their defaults.

```json
"recommendations": { "enabled": true, "recordInteractions": true },
"retention": { "behaviourDays": 548, "auditDays": 365 }
```

| Setting | Absent means | What it does |
| --- | --- | --- |
| `recommendations.enabled` | `true` | **The launch-day escape hatch.** Set to `false` and restart, and `recommendations.get` stops ranking: every request gets the deterministic baseline (upcoming, complete, recently added), computed from the listings alone without reading a single recommendation collection. The response says so — `fallbackUsed: true`, `fallbackReason: "disabled"` — and it is the same shape the pages already receive when ranking throws, so the feed and the deck keep working and nothing needs redeploying. Use it if ranking is slow, wrong, or the suspect in an incident. The startup projection still runs: the topics, venues and friend-activity privacy it writes are read by the rest of the product. |
| `recommendations.recordInteractions` | `true` | Set to `false` to stop the behaviour log: no interactions, impressions, item states, behaviour graph edges or request rows are written, and because a response then carries no request id the pages stop sending impressions, opens and flips. **RSVPs and attendance are still kept** — whether someone is going is what they told the product, not a note taken about them — and the graph edge of a plan that is cancelled or a group that is left is still ended, so a note already taken does not go on being wrong. Independent of `enabled`: recommendations can keep ranking on the history they have while recording is paused. **What people do while this is off is never logged afterwards.** The one-time behaviour backfill is for swipes and joins older than the log: it waits for a boot with recording on, runs once, and does not come back to fill a later pause. The ranker will not know about passes, Going or cancellations made in that window; an event someone stopped going to during it stays out of their deck, because the last thing the log heard was Going. Use it for an incident, not as a standing mode. |
| `retention.behaviourDays` | `548` (eighteen months) | How long what a person did is kept: `RecommendationInteractions` and `RecommendationImpressions` (from when written), `RecommendationUserItemStates`, `EventRSVPs` and `EventAttendances` (from their last change), `RecommendationRequests`, and the graph edges written from an interaction. Structural graph edges — topic, venue, host, friendship — never expire; the index is partial on `sourceInteractionId` for exactly that reason. Swipes and memberships themselves are product data and are not touched. |
| `retention.auditDays` | `365` | How long an `AuditLogCollection` entry is kept after it was written. |

Retention is enforced by MongoDB TTL indexes, built at startup by
`app/imports/api/retention/retention.js`; the TTL monitor deletes once a minute,
so a shortened limit removes older rows within a minute or two of the restart
and they cannot be got back. An existing index is moved to a new limit with
`collMod` rather than recreated. A value that is not a number of days, 1 or
more, is ignored in favour of the default and logged as `[retention] …`; a limit
that could not be applied is logged as `[retention] <collection> has NO expiry`.

Every start logs `[recommendations] scaffold ready in N ms (E events projected)`.
That work happens before the server accepts a connection, so N is part of every
deploy's downtime. The first start of a build that changes the topic or venue
tables projects every event (about four seconds on 1,242 events); any other
start projects only new and edited ones and should be well under a second.

## Made-up names in anonymous groups

Nothing to configure. In an anonymous group each person goes by one made-up
name ("Sleepy Honu"), worked out from their account id with a keyed hash
(`app/imports/api/privacy/anonymousNames.js`). The key matters: the people
directory sends every account id to every signed-in user and the word lists are
in the repository, so with an unkeyed hash anybody could work out everybody's
name.

The server makes the key itself the first time it needs one — 32 random bytes,
kept in the `ServerSecrets` collection, which is never published and has no
methods. It lives in the database so that it travels with the data: a restored
backup still produces the same handles. **Treat a database dump as holding a
secret**, as it already holds password hashes.

| Setting | Absent means | What it does |
| --- | --- | --- |
| `anonymousNames.secret` | the server's own, from `ServerSecrets` | Optional. A string of 32 or more random characters that is used INSTEAD of the stored key — for an operator who wants the key in their secret manager rather than in the database. Anything shorter, or not a string, is ignored in favour of the server's own and logged once as `[anonymous names] …`: every person is shown their own id and their own name, so a key that can be guessed can be checked against that pair offline. Never put it in `settings.sample.json` or anywhere else that is committed. |

What changing the key does, by either route:

- **Nobody is renamed.** A name is stored on the profile (`anonymousName`, under
  a unique index) the first time it is needed, and a stored name is never
  worked out again. Only people named afterwards are named with the new key.
- **Every member handle changes.** The per-group `handle` that `clubs.members`
  returns for a made-up row is worked out on asking and stored nowhere. Anything
  keyed by it has to be re-keyed by whoever changes the secret. Today nothing
  is; the blocking planned for anonymous groups will be.

So set `anonymousNames.secret` before the first boot or not at all.

Only an administrator can trace a made-up name to an account: the admin
Profiles list shows it on each person's card. Names are written to no log. The
first boot after this ships logs `Gave made-up names to N profiles.` once, and
is silent on every boot after.

The person who runs a group is shown a made-up name only for a membership made
WHILE the group was anonymous (`ProfileClubs.joinedAnonymous`, written at the
join and never afterwards). Nobody is listed both ways: one membership seen
once by name and once made-up would be that person's name in every other
anonymous group. So memberships from before this shipped, which carry no flag,
are counted and not listed in an anonymous group, and the group's page says how
many. There is no backfill, on purpose — nothing stored can say whether an
owner once read such a membership by name. **Do not set the flag by hand.**

## Rate limits in force

Set in `app/imports/startup/server/rateLimits.js`, plus one rule the
`accounts-base` package brings with it. A refusal is a `too-many-requests`
error carrying "That was a lot at once. Try again in N seconds." There is no
captcha, by decision; the abuse control that matters is email verification
before posting and moderation of listings, both in later phases. These limits
only keep abuse from being free.

Keyed by **address** — which is why `HTTP_FORWARDED_COUNT` matters:

| Method | Limit | Sized for |
| --- | --- | --- |
| `login` (password sign-in AND session resume) | 30 per minute | A room on one venue Wi-Fi reconnecting at once. |
| `createUser` | 20 per hour | A table of friends all joining at once, twice over. |

Keyed by **connection** (a connection is cheap to discard, so these are soft).
All but the first row come from `rateLimits.js`; the first is the rule the
`accounts-base` package installs on its own, which the app leaves in place:

| Method | Limit | Note |
| --- | --- | --- |
| `login`, `createUser`, `resetPassword`, `forgotPassword` | 5 per 10 s | `accounts-base`'s own default rule, left in place; it is what refuses a fast run of wrong passwords on one tab. |
| `eventSwipes.record`, `eventSwipes.remove` | 40 per 10 s | The deck; a card a second plus undo. |
| `recommendationInteractions.record` | 80 per 10 s | Fires alongside each swipe. |
| `recommendations.get` | 30 per 10 s | |
| `friends.request` | 10 per minute | Enumerable: the reply says whether an account exists. |
| `createUserProfile` | 5 per minute | Enumerable, and once per account in practice. |
| `Clubs.insert`, `Events.insert` | 8 per minute | Each carries an image. |
| `Profiles.update` | 20 per minute | Carries an image. |
| `ingestion.runs.requestSource` | 20 per minute | Administrator only. |
| `ingestion.runs.requestAll`, `ingestion.research.request`, `ingestion.candidates.approveAll` | 5 per minute | Administrator only; each is expensive. |
| `ingestion.candidates.approve`, `ingestion.candidates.saveEditorialOverrides` | 30 per minute | Administrator only. |
| every other app method | 30 per 10 s | The fallback. |

## Response headers

`app/imports/startup/server/securityHeaders.js` adds to every response:
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
`Permissions-Policy: camera=(), microphone=(), payment=(), geolocation=(self)`,
and, on an https `ROOT_URL` only, `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
The CSP is `frame-ancestors` alone on purpose: Meteor injects its runtime
configuration as an inline script, and a `script-src` breaks the client. A
full policy is later work.
