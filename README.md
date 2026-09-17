# UHnify

UHnify is a Meteor + React campus community app for discovering UH Mānoa clubs, joining organizations, creating events, and managing the directory from an admin dashboard.

This version is no longer just a visual mockup or lightly modified template. It now includes a much more complete product flow:

- Modernized landing page, navbar, footer, auth screens, cards, filters, profile screens, calendars, and admin dashboard.
- Searchable and filterable Club Finder.
- Personal **My Clubs** page backed by saved club memberships.
- Personalized **My Events** calendar based on the clubs a student joins.
- Profile display page and profile customization page with editable bio, title, interests, and profile image.
- Admin-only dashboard for managing clubs, events, and profiles.
- Server-side Meteor methods for create, update, delete, join, leave, and profile changes.
- Cleaned publications so users receive only the data each page needs.
- Safer startup seeding for users, profiles, clubs, events, interests, memberships, and event links.

## Project structure

```text
app/        Meteor application source
config/     Meteor settings files
doc/        Existing project documentation and screenshots
.github/    CI configuration
```

## Run locally

From the project root:

```bash
cd app
meteor npm install
meteor npm run start -- --port 3010
```

The start script runs Meteor with the development settings file. The port is passed through with `--` because Meteor reads it only from `--port`:

```bash
meteor --no-release-check --exclude-archs web.browser.legacy,web.cordova --settings ../config/settings.development.json --port 3010
```

Then open:

```text
http://localhost:3010
```

## Accounts

Accounts are created from the `defaultAccounts` list in the settings file passed with `--settings`, and only when the users collection is empty. Development uses `config/settings.development.json`, whose accounts are for local use only. A production deployment must supply its own settings file, with long random passwords and its own admin address (`app/.deploy/settings.sample.json` shows the shape). The server checks that file at startup and refuses to start with the development accounts, a placeholder address, or a placeholder secret in it; see `app/imports/startup/server/productionGuard.js` for exactly what it refuses.

In development you do not need to type those passwords. The sign-in page shows a "Development only" panel with one button per seeded account; a click signs you in. It exists only on a development server, only for the accounts `public.devSignIn` lists, and only for requests that came from this machine at every hop — see `app/imports/startup/server/devSignIn.js`. The production guard refuses to start if that key is present.

## Main routes

```text
/                  Landing page
/signin            Sign in
/signup            Multi-step registration
/search-clubs      Club Finder
/my-clubs          Joined clubs
/upcoming-events   Public event finder and calendar
/discover-events   Swipeable Discover deck (save or pass on events)
/agenda            Merged calendar: one-off events + recurring club meetings
/user-events       Personalized event calendar
/profile           Student profile
/settings          Edit profile details
/create-club       Create a club
/create-event      Create an event
/admin             Admin dashboard
```

## Quality checks

When dependencies are installed, run:

```bash
meteor npm run lint
```

A parse-level JS/JSX validation pass was run while preparing this handoff. The full Meteor app was not launched in this environment because the `meteor` CLI and local `node_modules` were not available here.

## Notes for future development

The app still intentionally uses the original project convention where the event form’s `eventID` field represents the host club number. I preserved that behavior because it was already wired into the previous implementation and tests, but the improved code now documents it clearly and also creates explicit event-to-club links.

A future cleanup pass could rename this field to `hostClubID` and add a separate unique `eventID`, but that would be a schema migration rather than a UI-only improvement.
