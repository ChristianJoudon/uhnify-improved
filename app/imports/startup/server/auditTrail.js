import { Meteor } from 'meteor/meteor';
import { AuditLog } from '../../api/audit/AuditLog';

/**
 * Wrap every registered method once, so the trail cannot be forgotten.
 *
 * The alternative — a logging call inside each method body — was rejected for
 * two reasons. It has to be remembered twenty-one times and again for every
 * method added afterwards, and it would run inside the CLIENT stub as well,
 * because the methods live in startup/both. This file is server-only and wraps
 * the handler table after it has been populated, so a method is audited by
 * existing rather than by opting in.
 *
 * It must therefore be imported AFTER Methods.js in server/main.js. Imported
 * before, the handler table is empty and this silently wraps nothing — which is
 * exactly the sort of quiet no-op an audit trail must not have, so it says so
 * out loud when it finds nothing to wrap.
 */

/** Anything longer than this is a payload, not an argument, and is not stored. */
const MAX_VALUE = 60;

/**
 * Describe an argument without keeping it.
 *
 * Ids and short strings are the useful part and are safe to keep. Images arrive
 * as data URLs of several megabytes; a bio is somebody's writing about
 * themselves and belongs in their profile, not in an operations log. Both are
 * reduced to their shape.
 */
const describe = value => {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      return `<image ${Math.round(value.length / 1024)}kb>`;
    }
    return value.length > MAX_VALUE ? `<text ${value.length}>` : value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  if (typeof value === 'object') {
    // Keys, not values: which fields an edit touched is the audit-worthy part,
    // and the values are the reader's own data.
    return `{${Object.keys(value).join(',')}}`;
  }
  return String(value);
};

const summarise = args => args.map(describe).join(', ').slice(0, 300);

/** Methods the app owns. Meteor's own account methods are excluded — they carry
    passwords and tokens, and logging them would be the leak this file exists to
    avoid. */
const OURS = /^(createUserProfile|Profiles\.|Clubs\.|clubs\.|Events\.|profileClubs\.|eventSwipes\.|friends\.)/;

export const installAuditTrail = () => {
  const handlers = Meteor.server.method_handlers;
  const names = Object.keys(handlers).filter(name => OURS.test(name));

  if (names.length === 0) {
    // Loud on purpose. Silence here would mean no trail at all, and the whole
    // point of the trail is that its absence is not silent.
    console.error('[audit] no methods matched — is auditTrail imported before Methods.js?');
    return 0;
  }

  names.forEach(name => {
    const original = handlers[name];
    if (original.mbAudited) {
      return;
    }

    function audited(...args) {
      const started = Date.now();
      const entry = {
        at: new Date(),
        actorId: this.userId || undefined,
        action: name,
        summary: summarise(args),
      };
      try {
        const result = original.apply(this, args);
        entry.outcome = 'ok';
        entry.ms = Date.now() - started;
        return result;
      } catch (error) {
        // A refused call is the half worth keeping: repeated `not-authorized`
        // against one method is what probing looks like from the outside.
        entry.outcome = 'error';
        entry.errorCode = `${error.error || error.message || 'unknown'}`.slice(0, 120);
        entry.ms = Date.now() - started;
        throw error;
      } finally {
        try {
          if (entry.actorId) {
            const user = Meteor.users.findOne(entry.actorId);
            entry.actorEmail = user?.username || user?.emails?.[0]?.address;
          }
          AuditLog.collection.insert(entry);
        } catch (logError) {
          // The trail must never be able to fail the thing it is recording.
          console.error('[audit] could not write entry for', name, logError.message);
        }
      }
    }

    audited.mbAudited = true;
    handlers[name] = audited;
  });

  return names.length;
};
