import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Link } from 'react-router-dom';
import { Container, Form } from 'react-bootstrap';
import swal from 'sweetalert';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import { GeoAlt, GeoAltFill, Search, X } from 'react-bootstrap-icons';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { Friends } from '../../api/friends/Friends';
import Club from '../components/Club';
import DetailsModal from '../components/DetailsModal';
import TopicMotif from '../components/TopicMotif';
import TopicPosters from '../components/TopicPosters';
import KindToggle from '../components/KindToggle';
import Segmented from '../components/form/Segmented';
import NearbyMap from '../components/NearbyMap';
import EventPoster from '../components/EventPoster';
import LoadingSpinner from '../components/LoadingSpinner';
import { normalizeCategories } from '../utilities/helpers';
import { scoreClub, sizeTier } from '../utilities/recommend';
import { TOPIC_KEYS, topicFor, topicForEvent } from '../utilities/topics';
import { KAUAI, milesLabel, milesTo, positionOf } from '../utilities/geo';
import { useOrigin } from '../utilities/useOrigin';
import { useTuck } from '../utilities/useTuck';

const PAGE_STEP = 12;
// Kauaʻi is roughly 33 miles across, so a 10-mile default from the island
// centre reaches one shore and calls the rest of the island far away. 25 covers
// it; the shorter radii become meaningful once someone shares a real position.
const RADII = [2, 5, 10, 25, 50];

const rise = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] } },
};

const ClubFinder = () => {
  // Geography-first, but the same two kinds of thing as Discover.
  const [kind, setKind] = useState('events');
  const [topicKey, setTopicKey] = useState(null);
  // One sheet, whichever kind was clicked: the reader is asking the same
  // question of an event as of a group.
  const [detail, setDetail] = useState(null);
  // A place picked off the map. It narrows the wall the same way a category
  // does — which is what the map is for. It used to open a popup that listed
  // every record at the venue by title, so a weekly market printed its own name
  // six times over a "+23 more".
  const [spot, setSpot] = useState(null);
  /**
   * Is this record at the pin the reader tapped?
   *
   * One predicate, read by the covers' counts, the count line, and the wall.
   * There were three copies of this test, on two different record shapes, and
   * they disagreed: the receipt said seven and the wall said nothing.
   *
   * The tolerance is a hair wider than exact, because a pin standing for a
   * cluster sits at its members' average rather than on any one of them.
   */
  const atSpot = record => {
    if (!spot) {
      return true;
    }
    const at = positionOf(record);
    return Boolean(at) && Math.abs(at.lat - spot.lat) < 0.02 && Math.abs(at.lng - spot.lng) < 0.02;
  };
  const [searchTerm, setSearchTerm] = useState('');
  const [sortMode, setSortMode] = useState('foryou');
  const [radius, setRadius] = useState(25);
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP + 6);
  const sentinelRef = useRef(null);
  const { origin, status, locate, reset, isPrecise, isExact } = useOrigin();
  const barTuck = useTuck();

  const { ready, clubs, events, joinedClubIds, goingIds, interests, friendClubIds } = useTracker(() => {
    const clubsSubscription = Meteor.subscribe(Clubs.userPublicationName);
    const eventsSubscription = Meteor.subscribe(Events.userPublicationName);
    const swipesSubscription = Meteor.subscribe(EventSwipes.userPublicationName);
    const membershipSubscription = Meteor.userId() ? Meteor.subscribe(ProfileClubs.membershipPublicationName) : { ready: () => true };
    Meteor.subscribe(Profiles.userPublicationName);
    Meteor.subscribe(Friends.userPublicationName);
    Meteor.subscribe('Friends.publication.activity');
    const profile = Profiles.collection.findOne({ userId: Meteor.userId() });
    const acceptedIds = Friends.collection.find({ status: 'accepted' }).fetch()
      .map(edge => (edge.requesterId === Meteor.userId() ? edge.receiverId : edge.requesterId));
    return {
      clubs: Clubs.collection.find({}).fetch(),
      events: Events.collection.find({}).fetch(),
      joinedClubIds: ProfileClubs.collection.find({ userId: Meteor.userId() }).fetch().map(membership => membership.clubId),
      goingIds: new Set(EventSwipes.collection
        .find({ userId: Meteor.userId(), decision: 'interested' }).map(swipe => swipe.eventId)),
      interests: normalizeCategories(profile?.interests),
      friendClubIds: new Set(ProfileClubs.collection.find({ userId: { $in: acceptedIds } }).fetch().map(membership => membership.clubId)),
      ready: clubsSubscription.ready() && membershipSubscription.ready()
        && eventsSubscription.ready() && swipesSubscription.ready(),
    };
  }, []);

  const scored = useMemo(() => {
    // The user's interests are topics, so resolve them to topic keys and let a
    // topic match be the dominant signal.
    const interestTopics = new Set(interests.map(interest => topicFor(interest).key));
    return clubs.map(club => {
      const categories = normalizeCategories(club.categories);
      const categoryKeys = categories.map(category => category.toLowerCase());
      const topic = topicFor(categories, club.tags, club.name, club.description);
      const score = scoreClub(club, { interests, friendClubIds, interestTopics, topicKey: topic.matched ? topic.key : null });
      return {
        club,
        score,
        tier: sizeTier(score),
        topic,
        distance: milesTo(club, origin),
        categoryKeys,
        // The poster and the rail read the same resolution, so a group can
        // never be one category on its card and another in the index.
        depts: topic.matched ? [topic.key] : [],
      };
    });
  }, [clubs, interests, friendClubIds, origin]);

  // Every filter EXCEPT the index's own selections, so a printed count is a
  // promise the grid keeps and picking one department never zeroes the others.
  const inScope = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return scored.filter(({ club, distance }) => (distance === null || distance <= radius)
      && (query === '' || [club.name, club.description, club.location, ...(club.tags || [])]
        .some(value => (value || '').toLowerCase().includes(query))));
  }, [scored, searchTerm, radius]);

  /** Events, scoped by the same geography and search as the groups — but NOT by
      the covers, because this is the list the covers count. */
  const eventsInScope = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const now = new Date();
    return events
      .filter(event => new Date(event.date) >= now)
      .map(event => ({
        event,
        topic: topicForEvent(event),
        distance: milesTo(event, origin),
      }))
      .filter(({ event, distance }) => (distance === null || distance <= radius)
        && (query === '' || `${event.title} ${event.description || ''} ${event.location || ''}`
          .toLowerCase().includes(query)))
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  }, [events, origin, radius, searchTerm]);

  const nearbyEvents = useMemo(
    () => (topicKey ? eventsInScope.filter(item => item.topic.key === topicKey) : eventsInScope),
    [eventsInScope, topicKey],
  );

  // Counted after every filter except the covers' own, so a cover says how much
  // is actually behind it. Tallying the already-topic-filtered list made the
  // other seven covers drop their count line the moment one was pressed; and
  // tallying every club on the island, before radius and search, made the group
  // covers promise more than the wall could ever show.
  // Seeded with a zero for every topic, so a cover with nothing behind it says
  // "nothing on" rather than going quiet — an absent count band and a count
  // band still loading look identical.
  const emptyTally = () => TOPIC_KEYS.reduce((tally, key) => ({ ...tally, [key]: 0 }), {});

  const eventTopicCounts = useMemo(() => {
    const tally = emptyTally();
    eventsInScope.filter(item => atSpot(item.event)).forEach(({ topic }) => {
      tally[topic.key] = (tally[topic.key] || 0) + 1;
    });
    return tally;
  }, [eventsInScope, spot]);

  const clubTopicCounts = useMemo(() => {
    const tally = emptyTally();
    inScope.filter(item => atSpot(item.club)).forEach(({ topic }) => {
      tally[topic.key] = (tally[topic.key] || 0) + 1;
    });
    return tally;
  }, [inScope, spot]);

  const filtered = useMemo(() => {
    // The covers do the categorising now: one control instead of a rail that
    // said the same thing in a second vocabulary.
    const list = topicKey ? inScope.filter(item => item.topic.key === topicKey) : inScope;
    if (sortMode === 'az') {
      return [...list].sort((a, b) => (a.club.name || '').localeCompare(b.club.name || ''));
    }
    if (sortMode === 'near') {
      // Records with no published place sort last rather than to the front.
      return [...list].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    }
    return [...list].sort((a, b) => b.score - a.score);
  }, [inScope, topicKey, sortMode]);

  /** What the map draws: whichever kind is showing, tagged with its colour, and
      always the same set the list below it is showing. */
  const mapRecords = useMemo(
    () => (kind === 'clubs'
      ? filtered.map(({ club, topic }) => ({ ...club, topicKey: topic.key }))
      : nearbyEvents.map(({ event, topic }) => ({ ...event, topicKey: topic.key }))),
    [kind, filtered, nearbyEvents],
  );

  // Paging follows whichever kind is on screen. Reading the club count while
  // events were showing stopped the events wall dead at the number of groups.
  const total = kind === 'events'
    ? nearbyEvents.filter(item => atSpot(item.event)).length
    : filtered.filter(item => atSpot(item.club)).length;

  useEffect(() => {
    setVisibleCount(PAGE_STEP + 6);
  }, [searchTerm, sortMode, radius, kind, topicKey]);

  // The chosen place survives a change of category — the two compose, so a pin
  // and a cover together answer "what art is on at Kukui Grove". It does NOT
  // survive a change of radius, kind or search: those redraw the map itself,
  // and a pin that is no longer on it cannot go on filtering the wall beneath.
  useEffect(() => {
    setSpot(null);
  }, [searchTerm, radius, kind]);

  // Re-observe after each growth so loading continues even when the sentinel
  // stays inside the preload margin.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(current => Math.min(current + PAGE_STEP, total));
      }
    }, { rootMargin: '900px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [total, visibleCount]);

  const join = clubId => {
    Meteor.call('profileClubs.add', clubId, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  /** The card's one action, and the sheet's: say yes to an event. */
  const toggleGoing = event => {
    if (!Meteor.userId()) {
      swal('Sign in first', 'Saving an event needs an account.', 'info');
      return;
    }
    const going = goingIds.has(event._id);
    const args = going ? [event._id] : [event._id, 'interested'];
    Meteor.call(going ? 'eventSwipes.remove' : 'eventSwipes.record', ...args, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  const clearFilters = () => {
    setSearchTerm('');
    setTopicKey(null);
  };

  // The empty state's escape hatch: clearing filters alone cannot help when the
  // radius is what excluded everything, so widen that too.
  const resetAll = () => {
    clearFilters();
    setRadius(RADII[RADII.length - 1]);
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  // One list feeds the wall, whichever kind is showing: the empty state and the
  // grid then read the same thing and cannot disagree about whether there is
  // anything here.
  // The place narrows the list BEFORE paging it. Filtering after the slice
  // asked "are any of the first eighteen at this pin", which for a pin on the
  // far side of the island is usually no — the receipt said seven and the wall
  // said nothing.
  const showing = kind === 'events'
    ? nearbyEvents
      .map(({ event, distance }) => ({ key: event._id, kind: 'event', record: event, distance }))
      .filter(item => atSpot(item.record))
      .slice(0, visibleCount)
    : filtered
      .map(({ club, tier, distance }) => ({ key: club._id, kind: 'club', record: club, tier, distance }))
      .filter(item => atSpot(item.record))
      .slice(0, visibleCount);
  const hasFilters = Boolean(searchTerm) || Boolean(topicKey);
  const noun = count => {
    const word = kind === 'clubs' ? 'group' : 'event';
    return count === 1 ? word : `${word}s`;
  };

  return (
    <Container id="browse-clubs-page" className="page-shell py-4" fluid="xl">
      <div className="page-intro">
        <h1>Nearby</h1>
        <p>Events and groups around you, closest first.</p>
      </div>

      {/* The controls run as one line above the frame rather than down a rail
          beside it. A rail costs the map and the wall 250px of width for the
          whole length of the page to hold two settings and a search box, and
          the map is the thing that needs the width most. */}
      <div className="finder-bar">
        <div className="finder-bar-block">
          <span className="finder-bar-title">You&apos;re matching for</span>
          {/* Tucks rather than wraps: the radius, the location button and the
              interests are one line whatever the width, and what does not fit
              slides under the edge to be scrolled back. */}
          <div ref={barTuck.ref} className={`finder-bar-row ${barTuck.className}`}>
            {/* `place` used to be read here from `profile.location` — a field
                the Profiles schema does not declare and nothing ever writes, so
                it was permanently undefined and this always fell through to the
                island name. The origin knows where it is measuring from; ask it. */}
            <span className="finder-bar-place">
              <GeoAlt size={15} /> {isPrecise ? origin.label : KAUAI.label}
              {/* Approximate is a different claim from located, and saying so
                  is the whole fix: the network lookup answers with the cable
                  company's building in Līhuʻe no matter which town you are
                  standing in, and the app used to present that as fact. */}
              {isPrecise && !isExact && <em className="finder-bar-hedge">roughly — from your network</em>}
            </span>
            {/* Five numbers, so all five are on the line. This was the control
                the owner pointed at: as a <select> the choice was hidden behind
                an OS-drawn menu that no stylesheet in this project can reach. */}
            <Segmented
              name="mb-radius"
              label="Within"
              unit="miles"
              value={radius}
              options={RADII.map(miles => ({ value: miles, label: miles, spoken: `Within ${miles} miles` }))}
              onChange={miles => setRadius(Number(miles))}
            />
            {/* Asked for, never assumed: the island centre is a fine default and
                a permission prompt on first paint is not. */}
            {/* Once a real position is in hand, the way back out of it has to
                be on screen — otherwise a stored one is permanent. */}
            {isPrecise ? (
              <>
                {/* A guess needs a way to be corrected, not just undone. */}
                {!isExact && (
                  <button type="button" className="mb-chip" onClick={locate} disabled={status === 'locating'}>
                    <GeoAltFill size={13} />
                    {status === 'locating' ? 'Finding you…' : 'Not right? Try again'}
                  </button>
                )}
                <button type="button" className="mb-chip" onClick={reset}>
                  <GeoAltFill size={13} />
                  Use the whole island
                </button>
              </>
            ) : (
              <button type="button" className="mb-chip" onClick={locate} disabled={status === 'locating'}>
                <GeoAltFill size={13} />
                {status === 'locating' ? 'Finding you…' : 'Use my location'}
              </button>
            )}
            {/* The interests moved in here rather than being dropped: they are
                the third thing this page matches on, and saying so beside the
                place and the radius is where they always belonged. */}
            {interests.slice(0, 5).map(interest => {
              const topic = topicFor(interest);
              return (
                <span className="finder-bar-interest" key={interest} style={{ background: topic.chip, color: topic.chipInk }}>
                  <TopicMotif name={topic.motif} className="" />
                  {interest}
                </span>
              );
            })}
            {interests.length > 0 && <Link className="finder-bar-edit" to="/settings">Edit</Link>}
          </div>
          {status === 'blocked' && (
            <p className="rail-note">
              Your browser is blocking location for this site. Allow it in the address bar, or keep
              browsing the whole island — everything is here either way.
            </p>
          )}
          {status === 'denied' && <p className="rail-note">Could not work out where you are. Measuring from the middle of the island.</p>}
        </div>

        <div className="finder-bar-search">
          <Search size={15} aria-hidden="true" />
          <Form.Control
            type="search"
            aria-label={kind === 'clubs' ? 'Search groups' : 'Search events'}
            placeholder={kind === 'clubs' ? 'Search groups…' : 'Search events…'}
            value={searchTerm}
            onChange={event => setSearchTerm(event.target.value)}
          />
        </div>
      </div>

      <div className="finder-body">
        {/* Geography first on this page: the map is the frame, and it always
            shows exactly the set listed underneath it. */}
        <NearbyMap
          records={mapRecords}
          origin={origin}
          chosen={spot}
          onSelect={next => setSpot(current => (
            current && current.lat === next.lat && current.lng === next.lng ? null : next))}
        />

        <KindToggle
          value={kind}
          onChange={setKind}
          counts={{ events: nearbyEvents.length, clubs: filtered.length }}
        />

        {/* Smaller than Discover's: here the covers are a filter, not the
              way in — the map above them already did that job. */}
        <TopicPosters
          selected={topicKey}
          onSelect={setTopicKey}
          counts={kind === 'clubs' ? clubTopicCounts : eventTopicCounts}
          compact
        />

        <div className="finder-toolbar">
          <div className="finder-count">
            {`${total} ${noun(total)} ${spot ? 'here' : `within ${radius} miles`}`}
          </div>
          {/* Groups only: `sortMode` never reaches the events list, which is
              always nearest-first. Left on the events tab, picking a sort reset
              the wall to eighteen cards in the very same order — which reads as
              broken rather than as unimplemented. */}
          {kind === 'clubs' && (
            <Segmented
              name="mb-sort"
              label="Sort"
              size="sm"
              value={sortMode}
              options={[
                { value: 'foryou', label: 'Recommended' },
                { value: 'near', label: 'Nearest' },
                { value: 'az', label: 'A–Z' },
              ]}
              onChange={setSortMode}
            />
          )}
        </div>

        {spot && (
          <div className="map-receipt" role="status">
            <GeoAlt size={14} aria-hidden="true" />
            {/* The place, not its count. The pin's own tally counts everything
                standing there, which stops being the number on the wall the
                moment a category is added on top — and the count line directly
                above this was already saying so. */}
            <span>At <strong>{spot.label || 'this place'}</strong></span>
            <button type="button" onClick={() => setSpot(null)}>
              Show everything <X size={13} aria-hidden="true" />
            </button>
          </div>
        )}

        {hasFilters && (
          <div className="idx-receipt" aria-label="Active filters" aria-live="polite">
            {searchTerm && (
              <button type="button" className="idx-stub" onClick={() => setSearchTerm('')}>
                {`“${searchTerm}”`}<X size={13} aria-hidden="true" />
                <span className="visually-hidden">Remove search</span>
              </button>
            )}
            <button type="button" className="idx-receipt-clear" onClick={clearFilters}>Clear all</button>
          </div>
        )}

        {showing.length === 0 ? (
          <div className="mb-empty">
            {/* Same three parts as every other empty state in the app — a
                glyph, what happened, and what to do about it. This one had
                only the first line and a button. */}
            <GeoAlt className="mb-empty-glyph" aria-hidden="true" />
            {/* Name the filter that actually excluded everything, and let the
                reset clear the radius too — otherwise it cannot recover. */}
            <h3>
              {spot && 'Nothing here right now.'}
              {!spot && (hasFilters ? 'Nothing matches those filters.' : `Nothing within ${radius} miles.`)}
            </h3>
            <p>
              {spot && 'Nothing at this pin matches the rest of your filters.'}
              {!spot && (hasFilters
                ? 'Try a shorter word, or drop the category and see the lot.'
                : `Kauaʻi is about thirty miles across, so a wider radius usually finds ${kind === 'clubs' ? 'more groups' : 'more events'}.`)}
            </p>
            <button
              type="button"
              onClick={() => { setSpot(null); if (!spot) { resetAll(); } }}
              className="btn btn-solid-primary"
            >
              {spot && 'Show everything'}
              {!spot && (hasFilters ? 'Clear filters' : 'Widen the search')}
            </button>
          </div>
        ) : (
          <div className="masonry">
            {showing.map(item => (
              <motion.div key={item.key} className="masonry-item" variants={rise} initial="hidden" animate="show">
                {item.kind === 'event' ? (
                  <EventPoster
                    event={item.record}
                    distance={milesLabel(item.distance)}
                    going={goingIds.has(item.record._id)}
                    onGoing={toggleGoing}
                    onOpen={() => setDetail({ record: item.record, kind: 'event' })}
                    tier="md"
                  />
                ) : (
                  <Club
                    club={item.record}
                    tier={item.tier}
                    distance={milesLabel(item.distance)}
                    isMember={joinedClubIds.includes(item.record._id)}
                    onAddToProfile={join}
                    onViewDetails={() => setDetail({ record: item.record, kind: 'club' })}
                  />
                )}
              </motion.div>
            ))}
          </div>
        )}

        {visibleCount < total && <div ref={sentinelRef} className="load-sentinel" />}
      </div>

      <DetailsModal
        show={Boolean(detail)}
        onHide={() => setDetail(null)}
        record={detail?.record}
        kind={detail?.kind || 'club'}
        isIn={detail?.kind === 'event'
          ? goingIds.has(detail?.record?._id)
          : joinedClubIds.includes(detail?.record?._id)}
        onAct={detail?.kind === 'event' ? toggleGoing : record => join(record._id)}
      />
    </Container>
  );
};

export default ClubFinder;
