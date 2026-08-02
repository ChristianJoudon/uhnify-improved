import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Link } from 'react-router-dom';
import { Container, Form } from 'react-bootstrap';
import swal from 'sweetalert';
import { useTracker } from 'meteor/react-meteor-data';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, GeoAlt, GeoAltFill, Search, X } from 'react-bootstrap-icons';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { Friends } from '../../api/friends/Friends';
import Club from '../components/Club';
import ClubDetailsModal from '../components/ClubDetailsModal';
import TopicMotif from '../components/TopicMotif';
import TopicPosters from '../components/TopicPosters';
import KindToggle from '../components/KindToggle';
import NearbyMap from '../components/NearbyMap';
import EventPoster from '../components/EventPoster';
import LoadingSpinner from '../components/LoadingSpinner';
import { normalizeCategories } from '../utilities/helpers';
import { scoreClub, sizeTier } from '../utilities/recommend';
import { TOPICS, topicFor } from '../utilities/topics';
import {
  CATEGORY_DEPT, DEPARTMENTS, DEPT_BY_KEY, KIND_LABEL,
} from '../utilities/departments';
import { KAUAI, milesLabel, milesTo } from '../utilities/geo';
import { useOrigin } from '../utilities/useOrigin';

const PAGE_STEP = 12;
// Kauaʻi is roughly 33 miles across, so a 10-mile default from the island
// centre reaches one shore and calls the rest of the island far away. 25 covers
// it; the shorter radii become meaningful once someone shares a real position.
const RADII = [2, 5, 10, 25, 50];

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const rise = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] } },
};

const ClubFinder = () => {
  // Geography-first, but the same two kinds of thing as Discover.
  const [kind, setKind] = useState('events');
  const [topicKey, setTopicKey] = useState(null);
  const [selectedDepts, setSelectedDepts] = useState([]);   // department keys
  const [selectedKinds, setSelectedKinds] = useState([]);   // lowercased category keys
  const [openDepts, setOpenDepts] = useState([]);           // disclosure only, never a filter
  const [selectedClub, setSelectedClub] = useState(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortMode, setSortMode] = useState('foryou');
  const [radius, setRadius] = useState(25);
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP + 6);
  const sentinelRef = useRef(null);
  const reduceMotion = useReducedMotion();
  const { origin, status, locate, isPrecise } = useOrigin();

  const { ready, clubs, events, joinedClubIds, interests, friendClubIds, place } = useTracker(() => {
    const clubsSubscription = Meteor.subscribe(Clubs.userPublicationName);
    const eventsSubscription = Meteor.subscribe(Events.userPublicationName);
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
      interests: normalizeCategories(profile?.interests),
      friendClubIds: new Set(ProfileClubs.collection.find({ userId: { $in: acceptedIds } }).fetch().map(membership => membership.clubId)),
      place: profile?.location,
      ready: clubsSubscription.ready() && membershipSubscription.ready() && eventsSubscription.ready(),
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

  /**
   * Directory-wide totals. `max` is the bar's denominator and it is deliberately
   * the UNFILTERED maximum: normalising against the filtered max would peg the
   * top bar at 100% forever and quietly destroy the drain, which is the whole
   * reason the bars are there.
   */
  const directory = useMemo(() => {
    const depts = {};
    const kinds = {};
    scored.forEach(item => {
      item.depts.forEach(key => { depts[key] = (depts[key] || 0) + 1; });
      item.categoryKeys.forEach(key => { kinds[key] = (kinds[key] || 0) + 1; });
    });
    return { depts, kinds, max: Math.max(1, ...Object.values(depts)) };
  }, [scored]);

  // Every filter EXCEPT the index's own selections, so a printed count is a
  // promise the grid keeps and picking one department never zeroes the others.
  const inScope = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return scored.filter(({ club, distance }) => (distance === null || distance <= radius)
      && (query === '' || [club.name, club.description, club.location, ...(club.tags || [])]
        .some(value => (value || '').toLowerCase().includes(query))));
  }, [scored, searchTerm, radius]);

  const index = useMemo(() => DEPARTMENTS
    .filter(dept => (directory.depts[dept.key] || 0) > 0)
    .map(dept => {
      const live = inScope.filter(item => item.depts.includes(dept.key));
      let state = 'off';
      if (selectedDepts.includes(dept.key)) {
        state = selectedKinds.some(key => CATEGORY_DEPT.get(key) === dept.key) ? 'refined' : 'on';
      }
      return {
        ...dept,
        state,
        count: live.length,
        share: Math.round((live.length / directory.max) * 100),
        kinds: dept.categories
          .map(category => category.toLowerCase())
          .filter(key => (directory.kinds[key] || 0) > 0 || selectedKinds.includes(key))
          .map(key => ({
            key,
            label: KIND_LABEL.get(key),
            count: live.filter(item => item.categoryKeys.includes(key)).length,
          }))
          // Count-descending, not alphabetical. Alphabetical is the order of a
          // list nobody edited, which was the original complaint.
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      };
    }), [inScope, directory, selectedDepts, selectedKinds]);

  // OR across departments; AND within one that has been refined to leaves.
  /** Events, scoped by the same geography and search as the groups. */
  const nearbyEvents = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const now = new Date();
    return events
      .filter(event => new Date(event.date) >= now)
      .map(event => ({
        event,
        topic: topicFor(event.title, event.description, normalizeCategories(event.categories)),
        distance: milesTo(event, origin),
      }))
      .filter(({ event, topic, distance }) => (distance === null || distance <= radius)
        && (!topicKey || topic.key === topicKey)
        && (query === '' || `${event.title} ${event.description || ''} ${event.location || ''}`
          .toLowerCase().includes(query)))
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  }, [events, origin, radius, searchTerm, topicKey]);

  const eventTopicCounts = useMemo(() => {
    const tally = {};
    nearbyEvents.forEach(({ topic }) => { tally[topic.key] = (tally[topic.key] || 0) + 1; });
    return tally;
  }, [nearbyEvents]);

  const clubTopicCounts = useMemo(() => {
    const tally = {};
    scored.forEach(({ topic }) => { tally[topic.key] = (tally[topic.key] || 0) + 1; });
    return tally;
  }, [scored]);

  const filtered = useMemo(() => {
    const list = selectedDepts.length === 0 ? inScope : inScope.filter(item => selectedDepts
      .some(key => {
        if (!item.depts.includes(key)) {
          return false;
        }
        const refine = selectedKinds.filter(kind => CATEGORY_DEPT.get(kind) === key);
        return refine.length === 0 || item.categoryKeys.some(kind => refine.includes(kind));
      }));
    if (sortMode === 'az') {
      return [...list].sort((a, b) => (a.club.name || '').localeCompare(b.club.name || ''));
    }
    if (sortMode === 'near') {
      // Records with no published place sort last rather than to the front.
      return [...list].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    }
    return [...list].sort((a, b) => b.score - a.score);
  }, [inScope, selectedDepts, selectedKinds, sortMode]);

  /** What the map draws: whichever kind is showing, tagged with its colour, and
      always the same set the list below it is showing. */
  const mapRecords = useMemo(() => (kind === 'clubs'
    ? filtered.map(({ club, topic }) => ({ ...club, topicKey: topic.key }))
    : nearbyEvents.map(({ event, topic }) => ({ ...event, topicKey: topic.key }))),
  [kind, filtered, nearbyEvents]);

  useEffect(() => {
    setVisibleCount(PAGE_STEP + 6);
  }, [searchTerm, selectedDepts, selectedKinds, sortMode, radius, kind, topicKey]);

  // Re-observe after each growth so loading continues even when the sentinel
  // stays inside the preload margin.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(current => Math.min(current + PAGE_STEP, filtered.length));
      }
    }, { rootMargin: '900px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filtered.length, visibleCount]);

  const join = clubId => {
    Meteor.call('profileClubs.add', clubId, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  // Turning a department off releases every leaf it owns, so selection state
  // can never disagree with itself.
  const toggleDept = key => {
    if (selectedDepts.includes(key)) {
      setSelectedDepts(selectedDepts.filter(item => item !== key));
      setSelectedKinds(selectedKinds.filter(kind => CATEGORY_DEPT.get(kind) !== key));
    } else {
      setSelectedDepts([...selectedDepts, key]);
    }
  };

  // Picking a leaf selects its department too — otherwise a refinement would
  // sit under a filter that is not on.
  const toggleKind = kindKey => {
    if (selectedKinds.includes(kindKey)) {
      setSelectedKinds(selectedKinds.filter(item => item !== kindKey));
      return;
    }
    setSelectedKinds([...selectedKinds, kindKey]);
    const parent = CATEGORY_DEPT.get(kindKey);
    if (!selectedDepts.includes(parent)) {
      setSelectedDepts([...selectedDepts, parent]);
    }
  };

  const toggleOpen = key => setOpenDepts(previous => (
    previous.includes(key) ? previous.filter(item => item !== key) : [...previous, key]));

  // openDepts is untouched — reading what is inside a department is not a filter.
  const clearFilters = () => {
    setSearchTerm('');
    setSelectedDepts([]);
    setSelectedKinds([]);
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

  const visible = filtered.slice(0, visibleCount);
  const hasFilters = Boolean(searchTerm) || selectedDepts.length > 0;

  return (
    <Container id="browse-clubs-page" className="page-shell py-4" fluid="xl">
      <div className="page-intro">
        <h1>Good matches for you</h1>
        <p>Groups near you, matched to what you actually care about.</p>
      </div>

      <div className="finder-layout">
        <aside className="filter-rail">
          <div className="rail-block">
            <div className="rail-title">You&apos;re matching for</div>
            <div className="rail-line">
              <GeoAlt size={15} /> {isPrecise ? origin.label : (place || KAUAI.label)}
            </div>
            <div className="rail-line">
              <GeoAlt size={15} />
              <select value={radius} onChange={event => setRadius(Number(event.target.value))} aria-label="Search radius">
                {RADII.map(miles => <option key={miles} value={miles}>Within {miles} miles</option>)}
              </select>
            </div>
            {/* Asked for, never assumed: the island centre is a fine default and
                a permission prompt on first paint is not. */}
            {!isPrecise && (
              <button type="button" className="rail-locate" onClick={locate} disabled={status === 'locating'}>
                <GeoAltFill size={13} />
                {status === 'locating' ? 'Finding you…' : 'Use my location'}
              </button>
            )}
            {status === 'denied' && <p className="rail-note">Measuring from the middle of the island.</p>}
          </div>

          {interests.length > 0 && (
            <div className="rail-block">
              <div className="rail-title">
                Your active interests
                <Link to="/settings">Edit</Link>
              </div>
              {interests.slice(0, 7).map(interest => {
                const topic = topicFor(interest);
                return (
                  <div className="rail-interest" key={interest}>
                    <span className="rail-dot" style={{ background: topic.chip, color: topic.chipInk }}>
                      <TopicMotif name={topic.motif} className="" />
                    </span>
                    {interest}
                  </div>
                );
              })}
            </div>
          )}

          <div className="rail-block">
            <div className="rail-title">Search</div>
            <div className="search-box" style={{ border: '1px solid var(--mb-line-soft)', borderRadius: 999 }}>
              <Search />
              <Form.Control
                type="text"
                placeholder="Search groups…"
                value={searchTerm}
                onChange={event => setSearchTerm(event.target.value)}
                className="search-input"
              />
            </div>
          </div>

          <div className="rail-block rail-index">
            <div className="rail-title">
              The Index
              <span className="idx-total">{scored.length}</span>
            </div>
            <div className="idx-rule" aria-hidden="true" />

            <ol className="idx-list">
              {index.map(dept => {
                const open = openDepts.includes(dept.key);
                // A department you have selected is never dead, so the filter
                // that emptied the page can always be switched back off.
                const dead = dept.count === 0 && dept.state === 'off';
                const wash = TOPICS[dept.topic];
                return (
                  <li
                    key={dept.key}
                    className={`idx-dept is-${dept.state}${dead ? ' is-dead' : ''}${open ? ' is-open' : ''}`}
                    style={{ '--idx-wash': wash.chip, '--idx-rule': wash.chipInk, '--idx-w': dept.share }}
                  >
                    {/* The filter. Full width — nothing sits beside it. */}
                    <button
                      type="button"
                      className="idx-entry"
                      aria-pressed={dept.state === 'refined' ? 'mixed' : dept.state === 'on'}
                      aria-disabled={dead}
                      onClick={() => { if (!dead) { toggleDept(dept.key); } }}
                    >
                      <span className="idx-folio" aria-hidden="true">{dept.folio}</span>
                      <span className="idx-name">{dept.label}</span>
                      <span className="idx-leader" aria-hidden="true" />
                      <span className="idx-count">{dept.count}</span>
                      <span className="visually-hidden">
                        {` ${dept.count === 1 ? 'group' : 'groups'}`}
                        {dept.state === 'refined' ? ', narrowed' : ''}
                        {dead ? ', none here right now' : ''}
                      </span>
                    </button>

                    {/* The weight. Drains as you filter. Not a control. */}
                    <span className="idx-weight" aria-hidden="true"><i /></span>

                    {/* The disclosure, stacked below — reading what is filed in
                        a department must not apply its filter. */}
                    {dept.kinds.length > 1 && (
                      <button
                        type="button"
                        className="idx-peek"
                        aria-expanded={open}
                        aria-controls={`idx-drawer-${slug(dept.key)}`}
                        onClick={() => toggleOpen(dept.key)}
                      >
                        {`${dept.kinds.length} filed here`}
                        <ChevronDown size={11} aria-hidden="true" />
                        <span className="visually-hidden">{` in ${dept.label}`}</span>
                      </button>
                    )}

                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          key="drawer"
                          id={`idx-drawer-${slug(dept.key)}`}
                          className="idx-drawer"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                        >
                          <p className="idx-note">{dept.note}</p>
                          <ul className="idx-kinds">
                            {dept.kinds.map(kind => {
                              const on = selectedKinds.includes(kind.key);
                              const kindDead = kind.count === 0 && !on;
                              return (
                                <li key={kind.key}>
                                  <button
                                    type="button"
                                    className={`idx-kind${on ? ' is-on' : ''}${kindDead ? ' is-dead' : ''}`}
                                    aria-pressed={on}
                                    aria-disabled={kindDead}
                                    onClick={() => { if (!kindDead) { toggleKind(kind.key); } }}
                                  >
                                    <span className="idx-tick" aria-hidden="true" />
                                    <span className="idx-name">{kind.label}</span>
                                    <span className="idx-leader" aria-hidden="true" />
                                    <span className="idx-count">{kind.count}</span>
                                    <span className="visually-hidden">
                                      {` ${kind.count === 1 ? 'group' : 'groups'}`}
                                    </span>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ol>

          </div>

          <div className="rail-block">
            <div className="rail-title">How matches work</div>
            <p className="rail-note">
              We compare your interests, location, and the groups your friends joined to surface
              ones you&apos;ll like.
            </p>
            <div className="rail-legend">
              <i /><i /><i /><span>Best fits appear larger</span>
            </div>
          </div>
        </aside>

        <div>
          {/* Geography first on this page: the map is the frame, and it always
              shows exactly the set listed underneath it. */}
          <NearbyMap records={mapRecords} origin={origin} height={280} />

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
              {kind === 'clubs'
                ? `${filtered.length} ${filtered.length === 1 ? 'group' : 'groups'} within ${radius} miles`
                : `${nearbyEvents.length} ${nearbyEvents.length === 1 ? 'event' : 'events'} within ${radius} miles`}
            </div>
            <label className="mb-sort" htmlFor="mb-sort-select">
              Sort:
              <select id="mb-sort-select" value={sortMode} onChange={event => setSortMode(event.target.value)}>
                <option value="foryou">Recommended</option>
                <option value="near">Nearest</option>
                <option value="az">A–Z</option>
              </select>
            </label>
          </div>

          {hasFilters && (
            <div className="idx-receipt" aria-label="Active filters" aria-live="polite">
              {searchTerm && (
                <button type="button" className="idx-stub" onClick={() => setSearchTerm('')}>
                  {`“${searchTerm}”`}<X size={13} aria-hidden="true" />
                  <span className="visually-hidden">Remove search</span>
                </button>
              )}
              {selectedDepts.map(key => (
                <button key={key} type="button" className="idx-stub" onClick={() => toggleDept(key)}>
                  {DEPT_BY_KEY[key].label}<X size={13} aria-hidden="true" />
                  <span className="visually-hidden">Remove filter</span>
                </button>
              ))}
              {selectedKinds.map(key => (
                <button key={key} type="button" className="idx-stub is-kind" onClick={() => toggleKind(key)}>
                  {KIND_LABEL.get(key)}<X size={13} aria-hidden="true" />
                  <span className="visually-hidden">Remove filter</span>
                </button>
              ))}
              <button type="button" className="idx-receipt-clear" onClick={clearFilters}>Clear all</button>
            </div>
          )}

          {kind === 'events' ? (
            nearbyEvents.length === 0 ? (
              <div className="mb-empty">
                <h3>Nothing within {radius} miles.</h3>
                <button type="button" onClick={resetAll} className="btn btn-solid-primary">Widen the search</button>
              </div>
            ) : (
              <div className="masonry">
                {nearbyEvents.slice(0, visibleCount).map(({ event, distance }) => (
                  <motion.div key={event._id} className="masonry-item" variants={rise} initial="hidden" animate="show">
                    <EventPoster
                      event={event}
                      neighborhood={event.region}
                      distance={milesLabel(distance)}
                      tier="md"
                    />
                  </motion.div>
                ))}
              </div>
            )
          ) : visible.length === 0 ? (
            <div className="mb-empty">
              {/* Name the filter that actually excluded everything, and let the
                  reset clear the radius too — otherwise it cannot recover. */}
              <h3>{hasFilters ? 'Nothing matches those filters.' : `Nothing within ${radius} miles.`}</h3>
              <button type="button" onClick={resetAll} className="btn btn-solid-primary">
                {hasFilters ? 'Clear filters' : 'Widen the search'}
              </button>
            </div>
          ) : (
            <div className="masonry">
              {visible.map(({ club, tier, distance }) => (
                <motion.div key={club._id} className="masonry-item" variants={rise} initial="hidden" animate="show">
                  <Club
                    club={club}
                    tier={tier}
                    distance={milesLabel(distance)}
                    isMember={joinedClubIds.includes(club._id)}
                    onAddToProfile={join}
                    onViewDetails={() => {
                      setSelectedClub(club);
                      setShowDetailsModal(true);
                    }}
                  />
                </motion.div>
              ))}
            </div>
          )}

          {visibleCount < filtered.length && <div ref={sentinelRef} className="load-sentinel" />}
        </div>
      </div>

      <ClubDetailsModal show={showDetailsModal} handleClose={() => setShowDetailsModal(false)} club={selectedClub} />
    </Container>
  );
};

export default ClubFinder;
