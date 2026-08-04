import React, { useMemo, useState } from 'react';
import { Container, Form, Image } from 'react-bootstrap';
import { useTracker } from 'meteor/react-meteor-data';
import { Meteor } from 'meteor/meteor';
import { Link } from 'react-router-dom';
import swal from 'sweetalert';
import { Check, Gear, PersonPlus, Search, X } from 'react-bootstrap-icons';
import LoadingSpinner from '../components/LoadingSpinner';
import { Profiles } from '../../api/profiles/Profiles';
import { Events } from '../../api/events/Events';
import { Clubs } from '../../api/club/Club';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { scheduleLabel } from '../../api/club/schedule';
import { formatShortDate, formatEventDate, normalizeCategories, profileImagePath } from '../utilities/helpers';
import { topicFor, topicForClub, topicForEvent } from '../utilities/topics';

const call = (method, ...args) => Meteor.call(method, ...args, error => {
  if (error) {
    swal('Error', error.reason || error.message, 'error');
  }
});

const displayName = person => `${person?.firstName || 'Student'} ${person?.lastName || ''}`.trim();

const Profile = () => {
  const [peopleQuery, setPeopleQuery] = useState('');
  const userId = Meteor.userId();

  const data = useTracker(() => {
    const subs = [
      Meteor.subscribe(Profiles.userPublicationName),
      Meteor.subscribe('Profiles.publication.directory'),
      Meteor.subscribe(Friends.userPublicationName),
      Meteor.subscribe('Friends.publication.activity'),
      Meteor.subscribe(ProfileClubs.membershipPublicationName),
      Meteor.subscribe(Clubs.userPublicationName),
      Meteor.subscribe(Events.userPublicationName),
      Meteor.subscribe(EventSwipes.userPublicationName),
    ];
    const edges = Friends.collection.find({}).fetch();
    const acceptedIds = edges
      .filter(edge => edge.status === 'accepted')
      .map(edge => (edge.requesterId === userId ? edge.receiverId : edge.requesterId));
    return {
      ready: subs.every(sub => sub.ready()),
      profile: Profiles.collection.findOne({ userId }),
      directory: Profiles.collection.find({ userId: { $exists: true, $ne: userId } }).fetch(),
      edges,
      acceptedIds,
      myMemberships: ProfileClubs.collection.find({ userId }).fetch(),
      friendMemberships: ProfileClubs.collection.find({ userId: { $in: acceptedIds } }).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
      events: Events.collection.find({}).fetch(),
      mySwipes: EventSwipes.collection.find({ userId }).fetch(),
      friendSwipes: EventSwipes.collection.find({ userId: { $in: acceptedIds }, decision: 'interested' }).fetch(),
    };
  }, [userId]);

  const {
    ready, profile, directory, edges, acceptedIds, myMemberships, friendMemberships,
    clubs, events, mySwipes, friendSwipes,
  } = data;

  const peopleById = useMemo(() => new Map(directory.map(person => [person.userId, person])), [directory]);
  const clubsById = useMemo(() => new Map(clubs.map(club => [club._id, club])), [clubs]);
  const eventsById = useMemo(() => new Map(events.map(event => [event._id, event])), [events]);

  const incoming = useMemo(
    () => edges.filter(edge => edge.status === 'pending' && edge.receiverId === userId),
    [edges, userId],
  );
  const connectedIds = useMemo(() => new Set([
    ...acceptedIds,
    ...edges.filter(edge => edge.status === 'pending').map(edge => (edge.requesterId === userId ? edge.receiverId : edge.requesterId)),
  ]), [acceptedIds, edges, userId]);

  const peopleResults = useMemo(() => {
    const query = peopleQuery.trim().toLowerCase();
    if (query.length < 2) {
      return [];
    }
    return directory
      .filter(person => !connectedIds.has(person.userId))
      .filter(person => displayName(person).toLowerCase().includes(query))
      .slice(0, 5);
  }, [directory, peopleQuery, connectedIds]);

  const { upcoming, past } = useMemo(() => {
    const now = new Date();
    const saved = mySwipes
      .filter(swipe => swipe.decision === 'interested')
      .map(swipe => eventsById.get(swipe.eventId))
      .filter(Boolean)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    return {
      upcoming: saved.filter(event => new Date(event.date) >= now),
      past: saved.filter(event => new Date(event.date) < now).reverse(),
    };
  }, [mySwipes, eventsById]);

  const myClubs = useMemo(
    () => myMemberships.map(membership => clubsById.get(membership.clubId)).filter(Boolean),
    [myMemberships, clubsById],
  );

  const friendActivity = useMemo(() => {
    const joins = friendMemberships.map(membership => ({
      key: `join-${membership._id}`,
      who: peopleById.get(membership.userId),
      verb: 'joined',
      what: clubsById.get(membership.clubId)?.name,
      when: membership.createdAt ? new Date(membership.createdAt) : null,
    }));
    const saves = friendSwipes.map(swipe => ({
      key: `save-${swipe._id}`,
      who: peopleById.get(swipe.userId),
      verb: 'is going to',
      what: eventsById.get(swipe.eventId)?.title,
      when: swipe.createdAt ? new Date(swipe.createdAt) : null,
    }));
    return [...joins, ...saves]
      .filter(item => item.who && item.what)
      .sort((a, b) => (b.when?.getTime() || 0) - (a.when?.getTime() || 0))
      .slice(0, 10);
  }, [friendMemberships, friendSwipes, peopleById, clubsById, eventsById]);

  if (!ready || !profile) {
    return <LoadingSpinner />;
  }

  const interests = normalizeCategories(profile.interests);
  // The header takes its colour from what this person is actually into.
  const topic = topicFor(interests, profile.title || '');

  return (
    <Container id="profile-page" className="page-shell py-4">
      <header className="profile-head">
        <div className="profile-head-band" style={{ background: topic.field, color: topic.ink }}>
          {/* The drawn illustration, not the retired geometric SVG. This page
              was the last surface still on the old watermark system. */}
          <img className="profile-head-art" src={topic.icon} alt="" />
        </div>
        <div className="profile-head-body">
          <Image src={profileImagePath(profile.picture)} alt="" className="profile-head-avatar" />
          <div className="profile-head-text">
            <h1>{displayName(profile)}</h1>
            {profile.title && <p>{profile.title}</p>}
            {profile.bio && <p className="profile-head-bio">{profile.bio}</p>}
            {interests.length > 0 && (
              <div className="preview-chips">
                {interests.map(interest => {
                  const chip = topicFor(interest);
                  return (
                    <span key={interest} className="topic-chip" style={{ background: chip.chip, color: chip.chipInk }}>
                      <img className="topic-chip-art" src={chip.icon} alt="" />
                      {interest}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div className="profile-head-side">
            <Link to="/settings" className="btn btn-soft-primary"><Gear /> Customize</Link>
            <div className="profile-stats">
              <div><strong>{myClubs.length}</strong><span>groups</span></div>
              <div><strong>{upcoming.length}</strong><span>going</span></div>
              <div><strong>{acceptedIds.length}</strong><span>friends</span></div>
            </div>
          </div>
        </div>
      </header>

      <div className="profile-grid">
        <section className="profile-panel">
          <h2>Coming up</h2>
          {upcoming.length === 0 && past.length === 0 && (
            <p className="panel-empty">Nothing yet. <Link to="/discover-events">Find something</Link>.</p>
          )}
          {upcoming.map(event => (
            <div key={event._id} className="panel-row">
              <span className="panel-mark" style={{ background: topicForEvent(event).chip }}>
                <img src={topicForEvent(event).icon} alt="" />
              </span>
              <div>
                <strong>{event.title}</strong>
                <span>{formatEventDate(event.date)} · {event.location}</span>
              </div>
            </div>
          ))}
          {past.length > 0 && (
            <>
              <h4 className="panel-subhead">Been to</h4>
              {past.map(event => (
                <div key={event._id} className="panel-row is-past">
                  <span className="panel-mark panel-mark--past">
                    <img src={topicForEvent(event).icon} alt="" />
                  </span>
                  <div>
                    <strong>{event.title}</strong>
                    <span>{formatShortDate(event.date)}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </section>

        <section className="profile-panel">
          <h2>Your groups</h2>
          {myClubs.length === 0 && (
            <p className="panel-empty">None yet. <Link to="/search-clubs">Browse groups</Link>.</p>
          )}
          {myClubs.map(club => {
            const clubTopic = topicForClub(club);
            return (
              <div key={club._id} className="panel-row">
                <span className="panel-mark" style={{ background: clubTopic.chip }}>
                  <img src={clubTopic.icon} alt="" />
                </span>
                <div>
                  <strong>{club.name}</strong>
                  <span>{scheduleLabel(club.schedule) || club.meetingTime}</span>
                </div>
              </div>
            );
          })}
        </section>

        <section className="profile-panel">
          <h2>Friends</h2>
          {incoming.map(edge => {
            const person = peopleById.get(edge.requesterId);
            return (
              <div key={edge._id} className="friend-row">
                <Image src={profileImagePath(person?.picture)} alt="" className="friend-avatar" />
                <div>
                  <div className="friend-name">{displayName(person)}</div>
                  <div className="friend-sub">wants to be friends</div>
                </div>
                <div className="friend-actions">
                  <button type="button" className="mb-icon-btn" aria-label={`Accept ${displayName(person)}`} onClick={() => call('friends.accept', edge._id)}><Check size={16} /></button>
                  <button type="button" className="mb-icon-btn mb-icon-btn--danger" aria-label={`Decline ${displayName(person)}`} onClick={() => call('friends.decline', edge._id)}><X size={16} /></button>
                </div>
              </div>
            );
          })}

          {acceptedIds.length === 0 && incoming.length === 0 && (
            <p className="panel-empty">No friends yet — find people below.</p>
          )}

          {acceptedIds.map(friendId => {
            const person = peopleById.get(friendId);
            if (!person) {
              return null;
            }
            return (
              <div key={friendId} className="friend-row">
                <Image src={profileImagePath(person.picture)} alt="" className="friend-avatar" />
                <div>
                  <div className="friend-name">{displayName(person)}</div>
                  {person.title && <div className="friend-sub">{person.title}</div>}
                </div>
                <div className="friend-actions">
                  <button type="button" className="mb-icon-btn mb-icon-btn--danger" aria-label={`Unfriend ${displayName(person)}`} onClick={() => call('friends.remove', friendId)}><X size={16} /></button>
                </div>
              </div>
            );
          })}

          <div className="search-box mt-3" style={{ border: '1px solid var(--mb-line-soft)', borderRadius: 999 }}>
            <Search />
            <Form.Control
              type="text"
              placeholder="Find people…"
              value={peopleQuery}
              onChange={event => setPeopleQuery(event.target.value)}
              className="search-input"
            />
          </div>
          {peopleResults.map(person => (
            <div key={person.userId} className="friend-row">
              <Image src={profileImagePath(person.picture)} alt="" className="friend-avatar" />
              <div>
                <div className="friend-name">{displayName(person)}</div>
                {person.title && <div className="friend-sub">{person.title}</div>}
              </div>
              <div className="friend-actions">
                <button type="button" className="mb-icon-btn" aria-label={`Add ${displayName(person)}`} onClick={() => call('friends.request', person.userId)}><PersonPlus size={16} /></button>
              </div>
            </div>
          ))}
          {peopleQuery.trim().length >= 2 && peopleResults.length === 0 && (
            <p className="panel-empty mt-2">No one found.</p>
          )}
        </section>

        <section className="profile-panel">
          <h2>What friends are up to</h2>
          {friendActivity.length === 0 ? (
            <p className="panel-empty">Nothing yet — add some friends.</p>
          ) : friendActivity.map(item => (
            <div key={item.key} className="friend-row">
              <Image src={profileImagePath(item.who.picture)} alt="" className="friend-avatar" />
              <div>
                <div className="activity-text"><strong>{displayName(item.who)}</strong> {item.verb} <strong>{item.what}</strong></div>
                {item.when && <div className="friend-sub">{formatShortDate(item.when)}</div>}
              </div>
            </div>
          ))}
        </section>
      </div>
    </Container>
  );
};

export default Profile;
