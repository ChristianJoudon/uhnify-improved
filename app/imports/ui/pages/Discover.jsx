import React, { useMemo } from 'react';
import { Meteor } from 'meteor/meteor';
import { Link } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import swal from 'sweetalert';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import LoadingSpinner from '../components/LoadingSpinner';
import MatchEventCard from '../components/MatchEventCard';
import GroupCard from '../components/GroupCard';
import NearbyMap from '../components/NearbyMap';
import { scheduleLabel } from '../../api/club/schedule';
import { normalizeCategories, sortByDate } from '../utilities/helpers';
import { scoreClub } from '../utilities/recommend';

const NEIGHBORHOODS = ['Mānoa', 'Kaimukī', 'Chinatown', 'Kakaʻako', 'Waikīkī', 'Kalihi'];

const seedValue = (id = '') => {
  let value = 0;
  for (let i = 0; i < id.length; i++) {
    value = (value * 31 + id.charCodeAt(i)) % 997;
  }
  return value;
};

const placeFor = id => {
  const value = seedValue(id);
  return {
    neighborhood: NEIGHBORHOODS[value % NEIGHBORHOODS.length],
    distance: `${(0.3 + (value % 45) / 10).toFixed(1)} mi`,
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

const rise = {
  hidden: { opacity: 0, y: 16 },
  show: index => ({ opacity: 1, y: 0, transition: { duration: 0.32, delay: Math.min(index, 5) * 0.05, ease: [0.2, 0.8, 0.2, 1] } }),
};

const Discover = () => {
  const userId = Meteor.userId();

  const { ready, events, clubs, swipes, memberships, interests, firstName } = useTracker(() => {
    const subs = [
      Meteor.subscribe(Events.userPublicationName),
      Meteor.subscribe(Clubs.userPublicationName),
      Meteor.subscribe(EventSwipes.userPublicationName),
      Meteor.subscribe(ProfileClubs.membershipPublicationName),
      Meteor.subscribe(Profiles.userPublicationName),
    ];
    const profile = Profiles.collection.findOne({ userId });
    return {
      ready: subs.every(sub => sub.ready()),
      events: Events.collection.find({}).fetch(),
      clubs: Clubs.collection.find({}).fetch(),
      swipes: EventSwipes.collection.find({ userId }).fetch(),
      memberships: ProfileClubs.collection.find({ userId }).fetch(),
      interests: normalizeCategories(profile?.interests),
      firstName: profile?.firstName || '',
    };
  }, [userId]);

  const savedIds = useMemo(
    () => new Set(swipes.filter(swipe => swipe.decision === 'interested').map(swipe => swipe.eventId)),
    [swipes],
  );
  const joinedIds = useMemo(() => new Set(memberships.map(membership => membership.clubId)), [memberships]);
  const clubByNumber = useMemo(() => new Map(clubs.map(club => [club.clubID, club])), [clubs]);

  const upcoming = useMemo(
    () => sortByDate(events.filter(event => new Date(event.date) >= new Date())),
    [events],
  );

  // Good matches: interest overlap with the host group's categories and tags.
  const goodMatches = useMemo(() => {
    const context = { interests, friendClubIds: new Set() };
    return [...upcoming]
      .map(event => {
        const host = clubByNumber.get(event.eventID);
        return { event, host, score: host ? scoreClub(host, context) : seedValue(event._id) / 997 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }, [upcoming, clubByNumber, interests]);

  const soon = useMemo(() => {
    const now = new Date();
    const horizon = new Date(now.getTime() + 8 * DAY_MS);
    return upcoming.filter(event => new Date(event.date) <= horizon).slice(0, 4);
  }, [upcoming]);

  const newGroups = useMemo(() => clubs.filter(club => !joinedIds.has(club._id)).slice(0, 4), [clubs, joinedIds]);

  // One deliberately broader recommendation, outside the user's usual categories.
  const different = useMemo(() => {
    if (upcoming.length === 0) {
      return null;
    }
    const offInterest = upcoming.filter(event => {
      const host = clubByNumber.get(event.eventID);
      const categories = normalizeCategories(host?.categories);
      return !categories.some(category => interests.some(interest => category.toLowerCase().includes(interest.toLowerCase())));
    });
    const pool = offInterest.length > 0 ? offInterest : upcoming;
    return pool[seedValue(userId || 'x') % pool.length];
  }, [upcoming, clubByNumber, interests, userId]);

  const toggleSave = event => {
    const isSaved = savedIds.has(event._id);
    const method = isSaved ? 'eventSwipes.remove' : 'eventSwipes.record';
    const args = isSaved ? [event._id] : [event._id, 'interested'];
    Meteor.call(method, ...args, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  const joinGroup = clubId => {
    Meteor.call('profileClubs.add', clubId, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  const renderEvent = (event, index) => {
    const place = placeFor(event._id);
    const host = clubByNumber.get(event.eventID);
    return (
      <motion.div key={event._id} variants={rise} initial="hidden" animate="show" custom={index}>
        <MatchEventCard
          event={event}
          hostName={host?.name || ''}
          neighborhood={place.neighborhood}
          distance={place.distance}
          saved={savedIds.has(event._id)}
          going={savedIds.has(event._id)}
          onSave={() => toggleSave(event)}
          onGoing={() => toggleSave(event)}
        />
      </motion.div>
    );
  };

  return (
    <main id="discover-page" className="mb-shell" style={{ paddingBottom: '2rem' }}>
      <section className="mb-section" style={{ marginTop: '2rem' }}>
        <h1 style={{ fontSize: 'clamp(1.8rem, 3.4vw, 2.5rem)', marginBottom: '0.35rem' }}>
          {firstName ? `Here's what's around you, ${firstName}.` : "Here's what's around you."}
        </h1>
        <p style={{ margin: 0 }}>A few things that fit your interests, schedule, and distance.</p>
      </section>

      {goodMatches.length > 0 && (
        <section className="mb-section">
          <div className="mb-section-head">
            <h2>Good matches</h2>
            <Link className="mb-section-link" to="/discover-events">Try match mode</Link>
          </div>
          <div className="mb-rail">
            {goodMatches.map(({ event }, index) => renderEvent(event, index))}
          </div>
        </section>
      )}

      {soon.length > 0 && (
        <section className="mb-section">
          <div className="mb-section-head">
            <h2>Happening soon</h2>
            <Link className="mb-section-link" to="/agenda">Open calendar</Link>
          </div>
          <div className="mb-grid">
            {soon.map((event, index) => renderEvent(event, index))}
          </div>
        </section>
      )}

      <section className="mb-section">
        <div className="mb-section-head">
          <h2>Near you</h2>
          <Link className="mb-section-link" to="/search-clubs">See the map</Link>
        </div>
        <div className="mb-map-strip">
          <NearbyMap count={Math.min(upcoming.length, 7)} />
          <div className="mb-map-overlay">
            <span>{upcoming.length} things within 5 miles</span>
            <Link className="btn btn-solid-primary" to="/search-clubs">Explore</Link>
          </div>
        </div>
      </section>

      {newGroups.length > 0 && (
        <section className="mb-section">
          <div className="mb-section-head">
            <h2>New groups</h2>
            <Link className="mb-section-link" to="/search-clubs">Browse all</Link>
          </div>
          <div className="mb-grid">
            {newGroups.map((club, index) => (
              <motion.div key={club._id} variants={rise} initial="hidden" animate="show" custom={index}>
                <GroupCard
                  club={club}
                  neighborhood={placeFor(club._id).neighborhood}
                  next={scheduleLabel(club.schedule)}
                  onJoin={() => joinGroup(club._id)}
                  isMember={joinedIds.has(club._id)}
                />
              </motion.div>
            ))}
          </div>
        </section>
      )}

      {different && (
        <section className="mb-section">
          <div className="mb-section-head">
            <h2>Try something different</h2>
          </div>
          <div style={{ maxWidth: 320 }}>
            {renderEvent(different, 0)}
          </div>
        </section>
      )}
    </main>
  );
};

export default Discover;
