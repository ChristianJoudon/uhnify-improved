/**
 * Kauaʻi register -> MatchBook seed.
 *
 * One declarative mapping run over every record, rather than per-record
 * handling. Absent source values stay absent: a key is written only when the
 * register actually published it, because the card schema treats a missing key
 * as "do not draw this row" and an empty string as content.
 *
 * The result is written to app/private/, not to Meteor.settings: settings is
 * configuration, a directory is data, and Meteor caps a settings file at 64k.
 * The server reads it with Assets.getText at startup.
 *
 * Lives in tools/ at the repo root, deliberately OUTSIDE app/: Meteor bundles
 * and executes every file under app/ except public/, private/ and tests/, so a
 * build script parked there runs as server code at boot and takes the server
 * down with it.
 *
 * Run from the repo root:
 *   node tools/import-register.mjs <register.json> app/private/seed-kauai.json
 */
import fs from 'fs';

const [, , REGISTER, OUT] = process.argv;
const reg = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));

/* ---------------------------------------------------------------- helpers */

const clean = value => {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const kept = value.map(clean).filter(v => v !== undefined);
    return kept.length ? kept : undefined;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text && !['n/a', 'na', 'tbd', 'tba', 'unknown'].includes(text.toLowerCase()) ? text : undefined;
  }
  return value;
};

/** Drop every undefined key so the document carries only what was published. */
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** Local wall-clock, so a 6pm listing is 6pm and not shifted by the offset. */
const at = (date, time) => {
  if (!date) return undefined;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0);
};

const venueLine = loc => clean(loc && (loc.venue || loc.address_line_1
  || [loc.city, loc.state].filter(Boolean).join(', ')));

const costOf = cost => {
  if (!cost || !cost.type || cost.type === 'unknown') return undefined;
  return compact({
    type: cost.type,
    amountMin: cost.amount_min ?? undefined,
    amountMax: cost.amount_max ?? undefined,
    raw: clean(cost.raw),
  });
};

const sourceOf = src => (src ? compact({
  publisher: clean(src.board_or_publisher),
  url: clean(src.url),
  lastChecked: clean(src.last_checked),
}) : undefined);

const registrationOf = r => {
  if (!r) return undefined;
  const method = clean(r.method);
  // Events say `required`/`recommended`; the recurring listings collapse both
  // into `required_or_recommended`, so the wording stays deliberately soft.
  if (r.required) return method ? `Registration required — ${method}` : 'Registration required';
  if (r.recommended) return method ? `Registration recommended — ${method}` : 'Registration recommended';
  if (r.required_or_recommended) return method ? `Booking advised — ${method}` : 'Booking advised';
  return method;
};

const DAY_CODE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HOUR = new Intl.DateTimeFormat('en-US', { hour: 'numeric' });
const HOUR_MIN = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const clock = hhmm => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return (m === 0 ? HOUR : HOUR_MIN).format(d);
};

/** The club's meeting line and the structured schedule the calendar reads. */
const meetingOf = club => {
  const rule = club.repeated_meeting_dates || {};
  const time = (club.meeting_times || [])[0] || {};
  const days = (rule.days_of_week || []).map(code => DAY_CODE[code]).filter(d => d !== undefined);
  const label = clean(rule.raw)
    || (days.length ? days.map(d => DAY_NAME[d]).join(' & ') : '');
  const when = clock(time.start_time);
  const line = [label, when].filter(Boolean).join(' · ');
  const schedule = days.length
    ? compact({ days, time: clean(time.start_time), cadence: rule.frequency === 'monthly' ? 'monthly' : (rule.interval === 2 ? 'biweekly' : 'weekly') })
    : undefined;
  return { line: line || undefined, schedule };
};

/* ------------------------------------------------------------------ clubs */

let clubID = 0;
const clubs = reg.clubs_and_groups.map(c => {
  clubID += 1;
  const { line, schedule } = meetingOf(c);
  return compact({
    clubID,
    name: c.name,
    owner: 'admin@foo.com',
    description: clean(c.description),
    location: venueLine(c.location) || clean(c.location && c.location.region) || 'Kauaʻi',
    meetingTime: line || 'Schedule to come',
    categories: clean(c.categories),
    tags: clean(c.club_type ? [c.club_type] : undefined),
    schedule,
    membership: clean(c.membership),
    region: clean(c.location && c.location.region),
    phone: clean(c.contact && c.contact.phone),
    email: clean(c.contact && c.contact.email),
    source: sourceOf(c.source),
  });
});

/** Name -> clubID, so an event can point at its organizer when we have one. */
const byName = new Map(clubs.map(c => [c.name.toLowerCase(), c.clubID]));

/* ----------------------------------------------------------------- events */

/** The register's window start; recurrences are expanded forward from here. */
const WINDOW_START = reg.event_window.start_date;
/**
 * How far a recurring listing is projected. Long enough that the calendar and
 * the "anytime" browse feel like a real island, short enough that a twice-weekly
 * fire show does not put three hundred rows in the deck. Everything past this
 * belongs to a refresh job, not to seed data.
 */
const HORIZON_WEEKS = 6;
const MAX_PER_LISTING = 6;

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Expand a recurrence rule into concrete dates. Date-component stepping rather
 * than millisecond arithmetic, so a DST change cannot shift a weekday.
 */
const expand = rule => {
  if (!rule) return [];
  if (Array.isArray(rule.explicit_dates) && rule.explicit_dates.length) {
    return rule.explicit_dates.slice(0, MAX_PER_LISTING);
  }
  const days = (rule.days_of_week || []).map(code => DAY_CODE[code]).filter(d => d !== undefined);
  if (!days.length) return [];

  const [sy, sm, sd] = (rule.effective_start_date || WINDOW_START).split('-').map(Number);
  const cursor = new Date(sy, sm - 1, sd);
  const floor = new Date(...WINDOW_START.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  if (cursor < floor) cursor.setTime(floor.getTime());

  const last = new Date(floor);
  last.setDate(last.getDate() + HORIZON_WEEKS * 7);
  if (rule.effective_end_date) {
    const [ey, em, ed] = rule.effective_end_date.split('-').map(Number);
    const stop = new Date(ey, em - 1, ed);
    if (stop < last) last.setTime(stop.getTime());
  }

  // Monthly rules name an ordinal ("first and third Thursday"); weekly rules
  // repeat every `interval` weeks from the first matching week.
  const monthly = rule.frequency === 'monthly';
  const positions = rule.set_positions || [];
  const interval = rule.interval && rule.interval > 1 ? rule.interval : 1;

  const out = [];
  const probe = new Date(cursor);
  let week = 0;
  while (probe <= last && out.length < MAX_PER_LISTING) {
    if (days.includes(probe.getDay())) {
      if (monthly) {
        const nth = Math.floor((probe.getDate() - 1) / 7) + 1;
        if (!positions.length || positions.includes(nth)) out.push(iso(probe));
      } else {
        week = Math.floor((probe - cursor) / (7 * 86400000));
        if (week % interval === 0) out.push(iso(probe));
      }
    }
    probe.setDate(probe.getDate() + 1);
  }
  return out;
};

/**
 * Every listing yields the days it actually happens. A one-time event has a
 * start date; a series has explicit dates; a recurring happening has a rule.
 */
const occurrences = e => {
  const s = e.schedule || {};
  if (Array.isArray(s.dates) && s.dates.length) return s.dates;
  if (s.start_date) return [s.start_date];
  return expand(e.recurrence);
};

const events = [];
for (const e of [...reg.events, ...reg.recurring_community_happenings]) {
  // Normalise the two shapes to one: a recurring listing keeps its clock in
  // meeting_times and its rule in recurrence.
  const times = (e.meeting_times || [])[0] || {};
  const s = e.schedule || { start_time: times.start_time, end_time: times.end_time };
  const host = clean(e.club_or_organizer);
  const hostId = host ? byName.get(host.toLowerCase()) : undefined;
  for (const day of occurrences(e)) {
    const start = at(day, s.start_time);
    if (!start) continue;
    // A multi-day run (a gallery week) keeps its own end; a single day takes
    // the end time if one was published.
    const endDay = s.end_date && s.end_date !== day && !s.dates ? s.end_date : day;
    events.push(compact({
      // Points at the organizing club when the register named one we imported;
      // otherwise 0, which the UI reads as "no host club".
      eventID: hostId || 0,
      title: e.name,
      description: clean(e.description),
      date: start,
      endDate: s.end_time ? at(endDay, s.end_time) : undefined,
      location: venueLine(e.location) || 'Kauaʻi',
      createdBy: 'admin@foo.com',
      owner: 'admin@foo.com',
      hostName: host,
      categories: clean(e.categories),
      region: clean(e.location && e.location.region),
      cost: costOf(e.cost),
      audience: clean(e.audience),
      registrationNote: registrationOf(e.registration),
      phone: clean(e.contact && e.contact.phone),
      email: clean(e.contact && e.contact.email),
      source: sourceOf(e.source),
    }));
  }
}

events.sort((a, b) => a.date - b.date);

/* ------------------------------------------------------------------ write */

const bundle = {
  generatedFrom: REGISTER.split('/').pop(),
  datasetName: reg.dataset_name,
  scope: reg.geographic_scope,
  verifiedOn: reg.last_public_web_verification_date,
  clubs,
  events: events.map(e => ({
    ...e,
    date: e.date.toISOString(),
    ...(e.endDate ? { endDate: e.endDate.toISOString() } : {}),
  })),
};

fs.writeFileSync(OUT, `${JSON.stringify(bundle, null, 2)}\n`);

/* ---------------------------------------------------------------- summary */

const field = (rows, key) => rows.filter(r => r[key] !== undefined).length;
console.log(`clubs   ${clubs.length}`);
console.log(`events  ${events.length}  (from ${reg.events.length} one-time + ${reg.recurring_community_happenings.length} recurring listings)`);
console.log(`        ${events.filter(e => e.eventID).length} linked to an imported club`);
console.log('\nfield coverage (a missing key means the card draws no row):');
for (const k of ['description', 'endDate', 'cost', 'audience', 'registrationNote', 'phone', 'hostName', 'region']) {
  const n = field(events, k);
  console.log(`  events.${k.padEnd(17)} ${String(n).padStart(3)}/${events.length}`);
}
for (const k of ['description', 'membership', 'phone', 'email', 'schedule']) {
  const n = field(clubs, k);
  console.log(`  clubs.${k.padEnd(18)} ${String(n).padStart(3)}/${clubs.length}`);
}
