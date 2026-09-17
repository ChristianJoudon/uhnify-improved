import React, { useEffect, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Roles } from 'meteor/alanning:roles';
import { Container, Image } from 'react-bootstrap';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import swal from 'sweetalert';
import { ArrowRepeat, Clipboard, ClipboardCheck } from 'react-bootstrap-icons';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import PosterArt from '../components/PosterArt';
import PrivacyToggles, { usePrivacySettings } from '../components/PrivacyToggles';
import { Clubs } from '../../api/club/Club';
import { ClubJoinRequests } from '../../api/club/ClubJoinRequests';
import { Profiles } from '../../api/profiles/Profiles';
import { clubMeetingLine } from '../utilities/cardFields';
import { isOpenToAll } from '../../api/listing/audience';
import { canManageListing } from '../../api/listing/ownership';
import { isAnonymousListing, isSensitiveListing } from '../../api/privacy/FriendActivityPrivacy';
import { formatShortDate, isPhoto, normalizeCategories, profileImagePath } from '../utilities/helpers';
import { topicForClub } from '../utilities/topics';

const nameOf = person => `${person?.firstName || ''} ${person?.lastName || ''}`.trim() || 'No name yet';

const countLabel = count => (count === 0 ? 'No members yet' : `${count} ${count === 1 ? 'member' : 'members'}`);

/**
 * A group's own page, for the person who runs it.
 *
 * Reached from "Manage" on My groups, and straight after the group is made. It
 * is where the owner's decisions live — private, anonymous, ask first — and
 * each is stored the moment its switch moves, with the server's answer drawn
 * back into the switches (see usePrivacySettings).
 *
 * The record comes from 'Clubs.publication.owned', the one publication that
 * carries `owner` and the invite token, and that sends them to nobody but the
 * owner. So "is this mine?" needs no method: for anyone else the record simply
 * never arrives, and they are shown the same notice an admin route shows.
 * An administrator is let through on the admin publication, because every
 * method below lets them through too.
 *
 * For an anonymous group the members are a list of made-up names — "Sleepy
 * Honu", joined Sep 3 — and there is no list of requests at all, since saying
 * yes to one means reading a name. That is all 'clubs.members' sends for such
 * a group, to its own owner as much as to anyone: no id, no face, nothing to
 * draw but the name. A group that was once anonymous shows both kinds of row
 * on one list, the people who joined under the promise still under theirs.
 * Nobody is ever drawn both ways, so whoever joined by name before the group
 * turned anonymous is on neither list, and the page says how many.
 *
 * The left column holds the poster as people meet it and nothing else yet.
 * Editing the listing, cancelling it, and blocking a member are a later phase;
 * the first two belong under the poster and the third on a member's row,
 * where `friend-actions` already keeps a slot.
 */
const ManageGroup = () => {
  const { _id } = useParams();
  const linkField = useRef(null);
  const copiedTimer = useRef(null);
  const [copied, setCopied] = useState(false);
  const [members, setMembers] = useState(null);
  const [membersAsOf, setMembersAsOf] = useState(null);
  const [membersTrouble, setMembersTrouble] = useState('');

  const { ready, club, requests } = useTracker(() => {
    const userId = Meteor.userId();
    const subs = [
      Meteor.subscribe('Clubs.publication.owned'),
      Meteor.subscribe(ClubJoinRequests.ownerPublicationName),
    ];
    // Roles arrive on a subscription of their own; until they have, "not an
    // admin" is not yet known, and deciding on it would bounce an admin who
    // loaded this page directly.
    const rolesReady = Roles.subscription.ready();
    if (rolesReady && Roles.userIsInRole(userId, 'admin')) {
      subs.push(Meteor.subscribe(Clubs.adminPublicationName));
    }
    const record = Clubs.collection.findOne(_id);
    return {
      ready: rolesReady && subs.every(sub => sub.ready()),
      // Another page may have left this group in the browser's copy of the
      // collection without `owner` on it. Only a record this person may
      // manage counts as found.
      club: canManageListing(userId, record) ? record : null,
      requests: ClubJoinRequests.collection
        .find({ clubId: _id, status: 'pending' }, { sort: { createdAt: 1 } })
        .map(request => ({ ...request, person: Profiles.collection.findOne({ userId: request.userId }) })),
    };
  }, [_id]);

  // Everything that can move the server's answer from outside this page, so
  // that it is asked again when any of it changes. The stored settings, since
  // an administrator or this person's other tab can move them — left out, the
  // switches went on showing the last answer this tab was given. And the
  // words that lock anonymity on: any member can add the tag 'recovery'.
  const watch = club ? [
    club.visibility,
    club.anonymous === true,
    club.approveMembers === true,
    ...normalizeCategories(club.categories),
    ...(club.tags || []),
  ].join('|') : '';
  const { settings, loaded, saving, change, trouble, retry } = usePrivacySettings('Clubs.setPrivacy', club?._id, club ? {
    visibility: isOpenToAll(club) ? 'public' : 'private',
    anonymous: isAnonymousListing(club),
    approveMembers: club.approveMembers === true && !isAnonymousListing(club),
    anonymousLocked: isSensitiveListing(club),
  } : null, watch);

  // Either one saying so is enough. The record arrives by subscription, ahead
  // of the answer it sets off, and a list of names should not stay up for the
  // length of that round trip because the last answer has not caught up.
  const anonymous = settings?.anonymous === true || (club ? isAnonymousListing(club) : false);
  const memberCount = club?.memberCount || 0;

  // The list is a method's answer, not a subscription, so it is asked for
  // again whenever the count moves: an approval, a new member through the
  // link, somebody leaving — and whenever the group turns anonymous or back,
  // because who may be listed moves with it.
  //
  // A refusal takes the list down; it used to leave the last one standing
  // under the server's sentence.
  useEffect(() => {
    if (!club?._id || !loaded) {
      setMembers(null);
      setMembersTrouble('');
      return undefined;
    }
    let active = true;
    Meteor.call('clubs.members', club._id, (error, list) => {
      if (!active) {
        return;
      }
      setMembersTrouble(error ? (error.reason || error.message) : '');
      setMembers(error ? null : list);
      // The count this list answers to. The count arrives by subscription,
      // ahead of the list it sets off, and for that round trip the two differ
      // by whoever just joined — which is not somebody who is "not listed".
      setMembersAsOf(memberCount);
    });
    return () => {
      active = false;
    };
  }, [club?._id, loaded, anonymous, memberCount]);

  // The group went anonymous — here, in another tab, or by a member adding
  // the tag 'recovery'. The names on screen come down NOW, not when the next
  // answer arrives without them: for the length of that round trip this page
  // would otherwise show every real name beside the words saying nobody sees
  // who they are. The effect above has already asked again.
  useEffect(() => {
    if (anonymous) {
      setMembers(null);
    }
  }, [anonymous]);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  if (!ready) {
    return <LoadingSpinner />;
  }
  if (!club) {
    return <Navigate to="/notauthorized" replace />;
  }

  const isPrivate = settings.visibility === 'private';
  // The link is drawn whenever it can let somebody in past a closed door:
  // into a private group, or past "Approve each person". A token minted while
  // the group was private goes on working after it turns public, so an owner
  // who asks first has to be able to see it, and replace it.
  const linkMatters = isPrivate || settings.approveMembers;
  const inviteUrl = club.inviteToken ? `${window.location.origin}/join/${club.inviteToken}` : '';
  const topic = topicForClub(club);
  // A row with a handle is somebody under their made-up name: whoever joined
  // while the group was anonymous, whether or not it still is. While it is,
  // nothing else is drawn, whatever arrived — an answer asked for a moment
  // before the switch moved can still land after it.
  const listed = (members || []).filter(member => (anonymous ? Boolean(member.handle) : true));
  const hasMadeUpNames = listed.some(member => member.handle);
  // The count is everyone and the list is not. The server sends nobody both
  // by name and made-up — one membership seen both ways is that person's
  // name in every anonymous group — so whoever joined by name before the
  // group turned anonymous is on neither list, then and after it is switched
  // back. The gap is said out loud: "3 members" over a short list reads as
  // something broken. Only where anonymity is what a gap means.
  const unlisted = members && membersAsOf === memberCount && (anonymous || club.anonymousUntil)
    ? Math.max(memberCount - listed.length, 0)
    : 0;

  const copyLink = () => {
    const done = () => {
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2400);
    };
    // Selected either way, so that where the clipboard is refused (an insecure
    // origin, an old browser) the link is one keystroke from copied.
    linkField.current?.select();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(inviteUrl).then(done, () => {});
    }
  };

  const rotate = () => Meteor.call('clubs.rotateInvite', club._id, error => {
    if (error) {
      swal('Not changed', error.reason || error.message, 'error');
    }
  });

  const makeNewLink = () => {
    swal({
      title: 'Make a new link?',
      text: 'The old link stops working. People who already joined stay in the group.',
      icon: 'warning',
      buttons: ['Keep this one', 'Make a new link'],
      dangerMode: true,
    }).then(confirmed => {
      if (confirmed) {
        setCopied(false);
        rotate();
      }
    });
  };

  // Every switch here is stored the moment it moves, and for all but this one
  // that is what the owner expects. Anonymous going OFF does less than it looks
  // like: the server never names the people who joined while nobody could see
  // who they were ('clubs.members'), so they stay under their made-up names
  // and only who joins from then on is shown by name. This used to promise the
  // opposite — "you will be able to see the 3 people in this group". So the
  // owner is told before the switch moves, not left to work it out from a
  // list that did not change. With nobody in the group there is nothing to
  // tell them, and the switch is just a switch.
  //
  // Going ON takes something away for good, and had no sentence at all. The
  // people listed by name leave the list — nobody is shown both ways — and
  // switching back does not return them, because by then they were in the
  // group while it was anonymous. An owner trying the switch to see what it
  // does should hear that first. Asked only when there is a name to lose.
  const changePrivacy = patch => {
    const namesListed = listed.filter(member => !member.handle).length;
    const asking = [
      patch.anonymous === false && memberCount > 0 && {
        title: 'Turn anonymous off?',
        text: 'People who joined while it was anonymous keep their made-up names. You will see names only for who joins from now on.',
        buttons: ['Keep it anonymous', 'Turn it off'],
      },
      patch.anonymous === true && namesListed > 0 && {
        title: 'Turn anonymous on?',
        text: `The ${namesListed === 1 ? 'person' : `${namesListed} people`} listed by name will not be listed any more, even if you turn it off again. New members appear under made-up names.`,
        buttons: ['Leave it off', 'Turn it on'],
      },
    ].find(Boolean);
    if (!asking) {
      change(patch);
      return;
    }
    swal({ ...asking, icon: 'warning', dangerMode: true }).then(confirmed => {
      if (confirmed) {
        change(patch);
      }
    });
  };

  const respond = (request, approve) => {
    Meteor.call('clubs.respondToRequest', request._id, approve, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  return (
    <Container id="manage-group" className="page-shell py-4">
      <PageHead
        eyebrow="Manage group"
        title={club.name}
        action={<Link to="/saved" className="btn btn-soft-primary">My groups</Link>}
      />

      <div className="create-layout">
        <aside className="create-preview">
          <span className="create-preview-label">{isPrivate ? 'What members see' : 'What people see'}</span>
          <div className="mb-poster mb-poster-lg">
            <PosterArt
              topic={topic}
              eyebrow={clubMeetingLine(club)}
              title={club.name}
              tagline={club.description}
              image={isPhoto(club.image) ? club.image : ''}
            />
            <div className="mb-poster-foot">
              <span className="mb-poster-meta">
                {club.location}
                <em>{topic.activityLabel || topic.label}</em>
              </span>
            </div>
          </div>
        </aside>

        <div className="create-form">
          <section className="form-block" aria-labelledby="manage-group-privacy">
            <h3 id="manage-group-privacy">Privacy</h3>
            <PrivacyToggles
              kind="club"
              idPrefix="manage-group"
              value={settings}
              anonymousLocked={settings.anonymousLocked === true}
              disabled={!loaded || saving}
              trouble={trouble}
              onRetry={retry}
              onChange={changePrivacy}
            />
          </section>

          {linkMatters && (
            <section className="form-block" aria-labelledby="manage-group-invite">
              <h3 id="manage-group-invite">Invite link</h3>
              <p className="form-note">
                {isPrivate
                  ? 'Anyone you send this to can join. It is the only way in.'
                  : 'Anyone you send this to joins without asking.'}
              </p>
              {inviteUrl && (
                <input
                  ref={linkField}
                  type="text"
                  className="manage-link-field"
                  readOnly
                  aria-label="Invite link"
                  value={inviteUrl}
                  onFocus={event => event.target.select()}
                />
              )}
              <div className="photo-row manage-link-actions">
                {inviteUrl && (
                  <button type="button" className="btn btn-soft-primary" onClick={copyLink}>
                    {copied ? <ClipboardCheck aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
                    {' '}
                    <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
                  </button>
                )}
                {/* A group made public and later asked-first has never had a
                    link; the same method that replaces one makes the first. */}
                <button
                  type="button"
                  className={`btn ${inviteUrl ? 'btn-outline-danger-soft' : 'btn-soft-primary'}`}
                  onClick={inviteUrl ? makeNewLink : rotate}
                >
                  <ArrowRepeat aria-hidden="true" /> {inviteUrl ? 'Make a new link' : 'Make a link'}
                </button>
              </div>
            </section>
          )}

          {!anonymous && (settings.approveMembers || requests.length > 0) && (
            <section className="form-block" aria-labelledby="manage-group-requests">
              <h3 id="manage-group-requests">Asking to join</h3>
              {requests.length === 0 && <p className="panel-empty">Nobody is waiting.</p>}
              {requests.map(request => (
                <div key={request._id} className="friend-row">
                  <Image
                    src={profileImagePath(request.person?.picture)}
                    alt=""
                    className="friend-avatar"
                    loading="lazy"
                    decoding="async"
                  />
                  <div>
                    <div className="friend-name">{nameOf(request.person)}</div>
                    <div className="friend-sub">Asked {formatShortDate(request.createdAt)}</div>
                  </div>
                  <div className="friend-actions">
                    <button type="button" className="btn btn-soft-primary" onClick={() => respond(request, true)}>
                      Approve
                      <span className="visually-hidden">{` ${nameOf(request.person)}`}</span>
                    </button>
                    <button type="button" className="btn btn-outline-danger-soft" onClick={() => respond(request, false)}>
                      Decline
                      <span className="visually-hidden">{` ${nameOf(request.person)}`}</span>
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <section className="form-block" aria-labelledby="manage-group-members">
            <h3 id="manage-group-members">Members</h3>
            <p className="manage-count">{countLabel(memberCount)}</p>
            {membersTrouble && <p className="panel-empty">{membersTrouble}</p>}
            {hasMadeUpNames && <p className="panel-empty">Made-up names — the same person keeps the same one.</p>}
            {/* One list for both kinds of row. A made-up row has a name and a
                day and nothing else, so it is drawn with the face everybody
                without a photo has; a later phase puts "Block" in the same
                `friend-actions` slot on either kind. */}
            {listed.map(member => (
              <div key={member.handle || member.userId} className="friend-row">
                <Image
                  src={profileImagePath(member.picture)}
                  alt=""
                  className="friend-avatar"
                  loading="lazy"
                  decoding="async"
                />
                <div>
                  <div className="friend-name">{member.handle ? (member.anonymousName || 'No name yet') : nameOf(member)}</div>
                  {member.joinedAt && <div className="friend-sub">Joined {formatShortDate(member.joinedAt)}</div>}
                </div>
              </div>
            ))}
            {unlisted > 0 && (
              <p className="panel-empty">
                {unlisted} joined before this group was anonymous. They are not listed.
              </p>
            )}
          </section>
        </div>
      </div>
    </Container>
  );
};

export default ManageGroup;
