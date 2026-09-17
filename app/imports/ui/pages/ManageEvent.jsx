import React from 'react';
import { Meteor } from 'meteor/meteor';
import { Roles } from 'meteor/alanning:roles';
import { Container } from 'react-bootstrap';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import swal from 'sweetalert';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import PosterArt from '../components/PosterArt';
import PrivacyToggles, { usePrivacySettings } from '../components/PrivacyToggles';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { isOpenToAll } from '../../api/listing/audience';
import { canManageListing } from '../../api/listing/ownership';
import { isAnonymousListing, isSensitiveListing, withHostSignals } from '../../api/privacy/FriendActivityPrivacy';
import { formatEventDate, isPhoto, normalizeCategories } from '../utilities/helpers';
import { topicForEvent } from '../utilities/topics';

const goingLabel = count => (count === 0 ? 'Nobody yet' : `${count} going`);

/** The words on a record that can make it sensitive. */
const wordsOf = record => (record ? [...normalizeCategories(record.categories), ...(record.tags || [])] : []);

/**
 * An event's own page, for the person who posted it. The same shape as
 * ManageGroup, and smaller: an event has no invite link and nobody asks to
 * come, so what is here is its privacy and how many are going.
 *
 * An event starts out following its host group, and says so. Moving either
 * switch makes the setting the event's own — the server stops it following
 * from that call on — and the line goes away because it has stopped being
 * true. There is no way back to following from here; the server offers none.
 *
 * A count and never a guest list, anonymous or not: no method hands one out.
 * For an anonymous event the page says that the count is all there is, so its
 * absence reads as the promise it is.
 *
 * The record comes from 'Events.publication.owned', which sends an event only
 * to whoever posted it — see ManageGroup for why that doubles as the check. It
 * sends nothing that is already over, so an event's page closes with the event.
 */
const ManageEvent = () => {
  const { _id } = useParams();

  const { ready, event, host } = useTracker(() => {
    const userId = Meteor.userId();
    const subs = [
      Meteor.subscribe('Events.publication.owned'),
      // The host group, wherever this person can be sent it from: the public
      // directory, the groups they are in, the groups they run. It is read
      // only to say WHY anonymity is locked; the server decides whether it is.
      Meteor.subscribe(Clubs.userPublicationName),
      Meteor.subscribe(ProfileClubs.userPublicationName),
      Meteor.subscribe('Clubs.publication.owned'),
    ];
    const rolesReady = Roles.subscription.ready();
    if (rolesReady && Roles.userIsInRole(userId, 'admin')) {
      subs.push(Meteor.subscribe(Events.adminPublicationName));
    }
    const record = Events.collection.findOne(_id);
    return {
      ready: rolesReady && subs.every(sub => sub.ready()),
      event: canManageListing(userId, record) ? record : null,
      host: Number.isInteger(record?.eventID) ? Clubs.collection.findOne({ clubID: record.eventID }) : undefined,
    };
  }, [_id]);

  const hosts = host ? [host] : [];
  // Everything that can move the server's answer from outside this page. The
  // event's own stored settings come first, because they are the ones most
  // often moved from elsewhere: while the event follows its group, the group
  // going private rewrites them, and this page went on showing "Private" off
  // under "Following X's settings" over an event that was private. Then what
  // can lock anonymity on: a sensitive word on the event or on its host, or
  // the host turning anonymous.
  const watch = [
    event?.visibility,
    event?.anonymous === true,
    event?.privacyInherited === true,
    ...wordsOf(event),
    host?.anonymous === true,
    ...wordsOf(host),
  ].join('|');
  const { settings, loaded, saving, change, trouble, retry } = usePrivacySettings('Events.setPrivacy', event?._id, event ? {
    visibility: isOpenToAll(event) ? 'public' : 'private',
    anonymous: isAnonymousListing(withHostSignals(event, hosts)),
    // The server's own question: would it still be anonymous with the event's
    // flag put down? Then the flag is not what is deciding.
    anonymousLocked: isAnonymousListing(withHostSignals({ ...event, anonymous: false }, hosts)),
  } : null, watch);

  if (!ready) {
    return <LoadingSpinner />;
  }
  if (!event) {
    return <Navigate to="/notauthorized" replace />;
  }

  const topic = topicForEvent(event);
  const hostName = event.hostName || host?.name || '';
  const goingCount = event.goingCount || 0;
  const cancelled = event.cancellationStatus === 'canceled';
  const toggleCancelled = () => {
    const ask = cancelled
      ? Promise.resolve(true)
      : swal({
        title: 'Cancel this event?',
        text: 'It comes off the walls and says Cancelled for everyone who was going. You can put it back on.',
        buttons: ['Keep it on', 'Cancel the event'],
        dangerMode: true,
      });
    ask.then(yes => yes && Meteor.call('Events.cancel', event._id, !cancelled, error => {
      if (error) {
        swal('Not changed', error.reason || error.message, 'error');
      }
    }));
  };
  // Two reasons a lock can have, and the server words them differently too. A
  // sensitive listing gets the standard line; a meeting of a group that chose
  // to be anonymous is told it is the group's choice, because its owner can
  // look for a health or faith word on the event all day and not find one.
  const lockedByHostChoice = settings.anonymousLocked === true
    && host?.anonymous === true
    && !isSensitiveListing(withHostSignals(event, hosts));

  return (
    <Container id="manage-event" className="page-shell py-4">
      <PageHead
        eyebrow="Manage event"
        title={event.title}
        action={<Link to="/user-events" className="btn btn-soft-primary">My events</Link>}
      />

      {event.moderation?.reason && (
        <p className="moderation-note" role="status">
          This event was taken down: {event.moderation.reason}
        </p>
      )}

      <div className="create-layout">
        <aside className="create-preview">
          <span className="create-preview-label">
            {settings.visibility === 'private' ? 'What members see' : 'What people see'}
          </span>
          <div className="mb-poster mb-poster-lg">
            <PosterArt
              topic={topic}
              eyebrow={formatEventDate(event.date)}
              title={event.title}
              tagline={event.description}
              image={isPhoto(event.image) ? event.image : ''}
            />
            <div className="mb-poster-foot">
              <span className="mb-poster-meta">
                {event.location}
                <em>{hostName || topic.activityLabel || topic.label}</em>
              </span>
            </div>
          </div>
        </aside>

        <div className="create-form">
          <section className="form-block" aria-labelledby="manage-event-privacy">
            <h3 id="manage-event-privacy">Privacy</h3>
            <PrivacyToggles
              kind="event"
              idPrefix="manage-event"
              value={settings}
              anonymousLocked={settings.anonymousLocked === true}
              lockedHelp={lockedByHostChoice ? `Always on, because ${hostName} is anonymous.` : ''}
              following={event.privacyInherited === true ? (hostName || 'its group') : ''}
              disabled={!loaded || saving}
              trouble={trouble}
              onRetry={retry}
              onChange={change}
            />
          </section>

          <section className="form-block" aria-labelledby="manage-event-change">
            <h3 id="manage-event-change">Change it</h3>
            <div className="moderation-row-actions">
              <Link className="btn btn-soft-primary" to={`/edit/event/${event._id}`}>Edit details</Link>
              {/* Called off, not deleted: the people who said they were going
                  are still shown it, saying so. */}
              <button type="button" className="btn btn-outline-danger-soft" onClick={toggleCancelled}>
                {cancelled ? 'Put it back on' : 'Cancel this event'}
              </button>
            </div>
            {cancelled && <p className="panel-empty">Cancelled. It is off the walls, and marked for everyone who was going.</p>}
          </section>

          <section className="form-block" aria-labelledby="manage-event-going">
            <h3 id="manage-event-going">Going</h3>
            <p className="manage-count">{goingLabel(goingCount)}</p>
            {settings.anonymous === true && (
              <p className="panel-empty">This event is anonymous, so there is no list — only a count.</p>
            )}
          </section>
        </div>
      </div>
    </Container>
  );
};

export default ManageEvent;
