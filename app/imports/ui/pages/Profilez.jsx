import React, { useMemo, useState } from 'react';
import { Badge, Card, Col, Container, Form, Image, Row } from 'react-bootstrap';
import { useTracker } from 'meteor/react-meteor-data';
import { Meteor } from 'meteor/meteor';
import swal from 'sweetalert';
import { Check, PersonPlus, Search, X } from 'react-bootstrap-icons';
import LoadingSpinner from '../components/LoadingSpinner';
import { Profiles } from '../../api/profiles/Profiles';
import { Events } from '../../api/events/Events';
import { Clubs } from '../../api/club/Club';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { EventSwipes } from '../../api/events/EventSwipes';
import { Friends } from '../../api/friends/Friends';
import { scheduleLabel } from '../../api/club/schedule';
import { formatShortDate, formatEventDate, normalizeCategories, profileImagePath } from '../utilities/helpers';

const callWithError = (method, ...args) => {
  Meteor.call(method, ...args, error => {
    if (error) {
      swal('Error', error.reason || error.message, 'error');
    }
  });
};

const displayName = profile => `${profile?.firstName || 'Student'} ${profile?.lastName || ''}`.trim();

const Profilez = () => {
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
    // Scope friend activity by the live accepted edges — never just "not me" —
    // so revoked friendships disappear from the feed instantly.
    const acceptedIds = edges
      .filter(edge => edge.status === 'accepted')
      .map(edge => (edge.requesterId === userId ? edge.receiverId : edge.requesterId));
    return {
      ready: subs.every(sub => sub.ready()),
      profile: Profiles.collection.findOne({ userId }),
      directory: Profiles.collection.find({ userId: { $exists: true, $ne: userId } }).fetch(),
      edges,
      myMemberships: ProfileClubs.collection.find({ userId }).fetch(),
      friendMemberships: ProfileClubs.collection.find({ userId: { $in: acceptedIds } }).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
      events: Events.collection.find({}).fetch(),
      mySwipes: EventSwipes.collection.find({ userId }).fetch(),
      friendSwipes: EventSwipes.collection.find({ userId: { $in: acceptedIds }, decision: 'interested' }).fetch(),
    };
  }, [userId]);

  const {
    ready, profile, directory, edges, myMemberships, friendMemberships, clubs, events, mySwipes, friendSwipes,
  } = data;

  const profilesByUserId = useMemo(() => {
    const map = new Map();
    directory.forEach(person => map.set(person.userId, person));
    return map;
  }, [directory]);

  const clubsById = useMemo(() => new Map(clubs.map(club => [club._id, club])), [clubs]);
  const eventsById = useMemo(() => new Map(events.map(event => [event._id, event])), [events]);

  const friendState = useMemo(() => {
    const incoming = edges.filter(edge => edge.status === 'pending' && edge.receiverId === userId);
    const outgoing = new Set(edges.filter(edge => edge.status === 'pending' && edge.requesterId === userId).map(edge => edge.receiverId));
    const accepted = edges.filter(edge => edge.status === 'accepted');
    const friendIds = accepted.map(edge => (edge.requesterId === userId ? edge.receiverId : edge.requesterId));
    const connectedIds = new Set([...friendIds, ...outgoing, ...incoming.map(edge => edge.requesterId)]);
    return { incoming, outgoing, friendIds, connectedIds };
  }, [edges, userId]);

  const peopleResults = useMemo(() => {
    const query = peopleQuery.trim().toLowerCase();
    if (query.length < 2) {
      return [];
    }
    return directory
      .filter(person => !friendState.connectedIds.has(person.userId))
      .filter(person => displayName(person).toLowerCase().includes(query))
      .slice(0, 6);
  }, [directory, peopleQuery, friendState]);

  const { upcomingEvents, pastEvents } = useMemo(() => {
    const now = new Date();
    const saved = mySwipes
      .filter(swipe => swipe.decision === 'interested')
      .map(swipe => eventsById.get(swipe.eventId))
      .filter(Boolean)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    return {
      upcomingEvents: saved.filter(event => new Date(event.date) >= now),
      pastEvents: saved.filter(event => new Date(event.date) < now).reverse(),
    };
  }, [mySwipes, eventsById]);

  const myClubs = useMemo(
    () => myMemberships.map(membership => clubsById.get(membership.clubId)).filter(Boolean),
    [myMemberships, clubsById],
  );

  // Friends' recent activity: clubs they joined and events they saved, newest first.
  const friendActivity = useMemo(() => {
    const joins = friendMemberships.map(membership => ({
      key: `join-${membership._id}`,
      who: profilesByUserId.get(membership.userId),
      what: 'joined',
      name: clubsById.get(membership.clubId)?.name,
      when: membership.createdAt ? new Date(membership.createdAt) : null,
    }));
    const saves = friendSwipes.map(swipe => ({
      key: `save-${swipe._id}`,
      who: profilesByUserId.get(swipe.userId),
      what: 'is going to',
      name: eventsById.get(swipe.eventId)?.title,
      when: swipe.createdAt ? new Date(swipe.createdAt) : null,
    }));
    return [...joins, ...saves]
      .filter(item => item.who && item.name)
      .sort((a, b) => (b.when?.getTime() || 0) - (a.when?.getTime() || 0))
      .slice(0, 12);
  }, [friendMemberships, friendSwipes, profilesByUserId, clubsById, eventsById]);

  if (!ready || !profile) {
    return <LoadingSpinner />;
  }

  const interests = normalizeCategories(profile.interests);

  return (
    <Container id="profile-page" className="page-shell py-5">
      <div className="profile-hero-card">
        <Image src="/images/Header.png" alt="Profile banner" className="profile-banner" />
        <div className="profile-hero-content">
          <Image src={profileImagePath(profile.picture)} alt="Profile" className="profile-avatar-xl" />
          <div>
            <h1>{displayName(profile)}</h1>
            <p>{profile.title || 'Member'} · {profile.email}</p>
          </div>
        </div>
      </div>

      <Row className="g-4 mt-1">
        <Col lg={7}>
          <Card className="profile-bio-card mb-4">
            <Card.Body>
              <h2>Your events</h2>
              {upcomingEvents.length === 0 && pastEvents.length === 0 && <p className="mb-0">Nothing yet — go swipe.</p>}
              {upcomingEvents.map(event => (
                <div key={event._id} className="activity-item">
                  <div>
                    <div className="activity-text"><strong>{event.title}</strong></div>
                    <div className="activity-sub">{formatEventDate(event.date)} · {event.location}</div>
                  </div>
                </div>
              ))}
              {pastEvents.length > 0 && (
                <>
                  <h4 className="mt-4" style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--stone)' }}>Attended</h4>
                  {pastEvents.map(event => (
                    <div key={event._id} className="activity-item">
                      <div>
                        <div className="activity-text">{event.title}</div>
                        <div className="activity-sub">{formatShortDate(event.date)}</div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </Card.Body>
          </Card>

          <Card className="profile-bio-card mb-4">
            <Card.Body>
              <h2>Friend activity</h2>
              {friendActivity.length === 0 ? (
                <p className="mb-0">Nothing yet — add some friends.</p>
              ) : friendActivity.map(item => (
                <div key={item.key} className="activity-item">
                  <Image src={profileImagePath(item.who.picture)} alt="" className="friend-avatar" />
                  <div>
                    <div className="activity-text"><strong>{displayName(item.who)}</strong> {item.what} <strong>{item.name}</strong></div>
                    {item.when && <div className="activity-sub">{formatShortDate(item.when)}</div>}
                  </div>
                </div>
              ))}
            </Card.Body>
          </Card>

          <Card className="profile-bio-card">
            <Card.Body>
              <h2>About</h2>
              <p className="mb-2">{profile.bio || 'No bio yet.'}</p>
              <div className="club-card-categories mt-2">
                {interests.map(interest => <Badge key={interest} className="club-category-tag">{interest}</Badge>)}
              </div>
            </Card.Body>
          </Card>
        </Col>

        <Col lg={5}>
          <Card className="profile-bio-card mb-4">
            <Card.Body>
              <h2>Friends</h2>

              {friendState.incoming.length > 0 && (
                <div className="mb-3">
                  {friendState.incoming.map(edge => {
                    const person = profilesByUserId.get(edge.requesterId);
                    return (
                      <div key={edge._id} className="friend-row">
                        <Image src={profileImagePath(person?.picture)} alt="" className="friend-avatar" />
                        <div>
                          <div className="friend-name">{displayName(person)}</div>
                          <div className="friend-sub">wants to be friends</div>
                        </div>
                        <div className="friend-actions">
                          <button type="button" className="icon-btn" aria-label="Accept" onClick={() => callWithError('friends.accept', edge._id)}><Check size={16} /></button>
                          <button type="button" className="icon-btn danger" aria-label="Decline" onClick={() => callWithError('friends.decline', edge._id)}><X size={16} /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {friendState.friendIds.length === 0 && friendState.incoming.length === 0 && (
                <p>No friends yet — find some below.</p>
              )}
              {friendState.friendIds.map(friendId => {
                const person = profilesByUserId.get(friendId);
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
                      <button type="button" className="icon-btn danger" aria-label={`Unfriend ${displayName(person)}`} onClick={() => callWithError('friends.remove', friendId)}><X size={16} /></button>
                    </div>
                  </div>
                );
              })}

              <div className="search-box mt-3" style={{ border: '1px solid var(--line)', borderRadius: 999 }}>
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
                    <button type="button" className="icon-btn" aria-label={`Add ${displayName(person)}`} onClick={() => callWithError('friends.request', person.userId)}><PersonPlus size={16} /></button>
                  </div>
                </div>
              ))}
              {peopleQuery.trim().length >= 2 && peopleResults.length === 0 && (
                <p className="friend-sub mt-2 mb-0">No one found.</p>
              )}
            </Card.Body>
          </Card>

          <Card className="profile-bio-card">
            <Card.Body>
              <h2>Your clubs</h2>
              {myClubs.length === 0 && <p className="mb-0">None yet.</p>}
              {myClubs.map(club => (
                <div key={club._id} className="activity-item">
                  <div>
                    <div className="activity-text"><strong>{club.name}</strong></div>
                    <div className="activity-sub">{scheduleLabel(club.schedule) || club.meetingTime}</div>
                  </div>
                </div>
              ))}
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  );
};

export default Profilez;
