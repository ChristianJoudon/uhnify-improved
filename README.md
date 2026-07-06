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
meteor npm run start
```

The start script runs Meteor with the development settings file:

```bash
meteor --no-release-check --exclude-archs web.browser.legacy,web.cordova --settings ../config/settings.development.json
```

Then open:

```text
http://localhost:3000
```

## Default accounts

The development settings file creates these users on first run:

```text
admin@foo.com / changeme   admin account
john@foo.com  / changeme   regular user account
```

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
