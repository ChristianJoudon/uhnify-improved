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
