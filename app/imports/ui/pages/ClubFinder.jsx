import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Link } from 'react-router-dom';
import { Alert, Button, Container, Form } from 'react-bootstrap';
import swal from 'sweetalert';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import { GeoAlt, Search } from 'react-bootstrap-icons';
import { Clubs } from '../../api/club/Club';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { Friends } from '../../api/friends/Friends';
import Club from '../components/Club';
import ClubDetailsModal from '../components/ClubDetailsModal';
import TopicMotif from '../components/TopicMotif';
import LoadingSpinner from '../components/LoadingSpinner';
import { normalizeCategories } from '../utilities/helpers';
import { scoreClub, sizeTier } from '../utilities/recommend';
import { TOPICS, TOPIC_KEYS, topicFor } from '../utilities/topics';

const PAGE_STEP = 12;
const RADII = [2, 5, 10, 25];

// Placeholder geography until real coordinates land — deterministic per club.
// The spread has to exceed the largest radius, or the radius control is inert.
const distanceFor = (id = '') => {
  let value = 0;
  for (let i = 0; i < id.length; i++) {
    value = (value * 31 + id.charCodeAt(i)) % 997;
  }
  return Math.round((0.2 + (value % 280) / 10) * 10) / 10;
};

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const rise = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] } },
};

const ClubFinder = () => {
  const [selectedTopics, setSelectedTopics] = useState([]);
  const [selectedCategories, setSelectedCategories] = useState([]);
  const [selectedClub, setSelectedClub] = useState(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortMode, setSortMode] = useState('foryou');
  const [radius, setRadius] = useState(10);
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP + 6);
  const sentinelRef = useRef(null);

  const { ready, clubs, joinedClubIds, interests, friendClubIds, place } = useTracker(() => {
    const clubsSubscription = Meteor.subscribe(Clubs.userPublicationName);
    const membershipSubscription = Meteor.userId() ? Meteor.subscribe(ProfileClubs.membershipPublicationName) : { ready: () => true };
    Meteor.subscribe(Profiles.userPublicationName);
    Meteor.subscribe(Friends.userPublicationName);
    Meteor.subscribe('Friends.publication.activity');
    const profile = Profiles.collection.findOne({ userId: Meteor.userId() });
    const acceptedIds = Friends.collection.find({ status: 'accepted' }).fetch()
      .map(edge => (edge.requesterId === Meteor.userId() ? edge.receiverId : edge.requesterId));
    return {
      clubs: Clubs.collection.find({}).fetch(),
      joinedClubIds: ProfileClubs.collection.find({ userId: Meteor.userId() }).fetch().map(membership => membership.clubId),
      interests: normalizeCategories(profile?.interests),
      friendClubIds: new Set(ProfileClubs.collection.find({ userId: { $in: acceptedIds } }).fetch().map(membership => membership.clubId)),
      place: profile?.location || 'Honolulu, HI',
      ready: clubsSubscription.ready() && membershipSubscription.ready(),
    };
  }, []);

  const categories = useMemo(() => {
    const unique = new Set();
    clubs.forEach(club => normalizeCategories(club.categories).forEach(category => unique.add(category)));
    return [...unique].sort();
  }, [clubs]);

  const scored = useMemo(() => {
    const context = { interests, friendClubIds };
    return clubs.map(club => {
      const score = scoreClub(club, context);
      return {
        club,
        score,
        tier: sizeTier(score),
        topic: topicFor(normalizeCategories(club.categories), club.tags, club.name, club.description),
        distance: distanceFor(club._id),
      };
    });
  }, [clubs, interests, friendClubIds]);

  // Only topics actually present in the directory become chips.
  const availableTopics = useMemo(() => {
    const present = new Set(scored.map(item => item.topic.key));
    return TOPIC_KEYS.filter(key => present.has(key));
  }, [scored]);

  const filtered = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const list = scored.filter(({ club, topic, distance }) => {
      const clubCategories = normalizeCategories(club.categories);
      const clubTags = club.tags || [];
      const matchesSearch = query === '' || [club.name, club.description, club.location, ...clubTags]
        .some(value => (value || '').toLowerCase().includes(query));
      const matchesTopics = selectedTopics.length === 0 || selectedTopics.includes(topic.key);
      const matchesCategories = selectedCategories.length === 0 || clubCategories.some(category => selectedCategories.includes(category));
      return matchesSearch && matchesTopics && matchesCategories && distance <= radius;
    });
    if (sortMode === 'az') {
      return [...list].sort((a, b) => (a.club.name || '').localeCompare(b.club.name || ''));
    }
    if (sortMode === 'near') {
      return [...list].sort((a, b) => a.distance - b.distance);
    }
    return [...list].sort((a, b) => b.score - a.score);
  }, [scored, searchTerm, selectedTopics, selectedCategories, sortMode, radius]);

  useEffect(() => {
    setVisibleCount(PAGE_STEP + 6);
  }, [searchTerm, selectedTopics, selectedCategories, sortMode, radius]);

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

  const toggleIn = setter => value => {
    setter(previous => (previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value]));
  };
  const toggleTopic = toggleIn(setSelectedTopics);
  const toggleCategory = toggleIn(setSelectedCategories);

  const clearFilters = () => {
    setSearchTerm('');
    setSelectedTopics([]);
    setSelectedCategories([]);
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
  const hasFilters = searchTerm || selectedTopics.length > 0 || selectedCategories.length > 0;

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
            <div className="rail-line"><GeoAlt size={15} /> {place}</div>
            <div className="rail-line">
              <GeoAlt size={15} />
              <select value={radius} onChange={event => setRadius(Number(event.target.value))} aria-label="Search radius">
                {RADII.map(miles => <option key={miles} value={miles}>Within {miles} miles</option>)}
              </select>
            </div>
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

          <div className="rail-block">
            <div className="rail-title">Categories</div>
            {categories.map(category => (
              <Form.Check
                key={category}
                type="checkbox"
                id={`filter-${slug(category)}`}
                checked={selectedCategories.includes(category)}
                onChange={() => toggleCategory(category)}
                label={category}
              />
            ))}
            {hasFilters && (
              <Button type="button" className="btn-soft-primary mt-2" onClick={clearFilters}>Clear all</Button>
            )}
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
          <div className="finder-toolbar">
            <div className="finder-count">
              {filtered.length} {filtered.length === 1 ? 'group' : 'groups'} within {radius} miles
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

          <div className="chip-row">
            {availableTopics.map(key => (
              <button
                key={key}
                type="button"
                className={`chip${selectedTopics.includes(key) ? ' is-on' : ''}`}
                aria-pressed={selectedTopics.includes(key)}
                onClick={() => toggleTopic(key)}
              >
                {TOPICS[key].label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <Alert className="empty-state-card">
              {/* Name the filter that actually excluded everything, and let the
                  reset clear the radius too — otherwise it cannot recover. */}
              <h2>{hasFilters ? 'Nothing matches those filters.' : `Nothing within ${radius} miles.`}</h2>
              <Button type="button" onClick={resetAll} className="btn-solid-primary">
                {hasFilters ? 'Clear filters' : 'Widen the search'}
              </Button>
            </Alert>
          ) : (
            <div className="masonry">
              {visible.map(({ club, tier, distance }) => (
                <motion.div key={club._id} className="masonry-item" variants={rise} initial="hidden" animate="show">
                  <Club
                    club={club}
                    tier={tier}
                    distance={`${distance.toFixed(1)} mi`}
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
