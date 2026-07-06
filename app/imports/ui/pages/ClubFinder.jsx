import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Alert, Button, Container, Form } from 'react-bootstrap';
import swal from 'sweetalert';
import { useTracker } from 'meteor/react-meteor-data';
import { motion } from 'framer-motion';
import { Search } from 'react-bootstrap-icons';
import { Clubs } from '../../api/club/Club';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { Friends } from '../../api/friends/Friends';
import Club from '../components/Club';
import ClubDetailsModal from '../components/ClubDetailsModal';
import LoadingSpinner from '../components/LoadingSpinner';
import { normalizeCategories } from '../utilities/helpers';
import { scoreClub, sizeTier } from '../utilities/recommend';

const PAGE_STEP = 12;

const rise = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 200, damping: 24 } },
};

const ClubFinder = () => {
  const [selectedCategories, setSelectedCategories] = useState([]);
  const [selectedTags, setSelectedTags] = useState([]);
  const [selectedClub, setSelectedClub] = useState(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortMode, setSortMode] = useState('foryou');
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP + 6);
  const sentinelRef = useRef(null);

  const { ready, clubs, joinedClubIds, interests, friendClubIds } = useTracker(() => {
    const clubsSubscription = Meteor.subscribe(Clubs.userPublicationName);
    const membershipSubscription = Meteor.userId() ? Meteor.subscribe(ProfileClubs.membershipPublicationName) : { ready: () => true };
    Meteor.subscribe(Profiles.userPublicationName);
    Meteor.subscribe(Friends.userPublicationName);
    Meteor.subscribe('Friends.publication.activity');
    const profile = Profiles.collection.findOne({ userId: Meteor.userId() });
    // Friend boost only counts CURRENT accepted friends, never stale session data.
    const acceptedIds = Friends.collection.find({ status: 'accepted' }).fetch()
      .map(edge => (edge.requesterId === Meteor.userId() ? edge.receiverId : edge.requesterId));
    return {
      clubs: Clubs.collection.find({}).fetch(),
      joinedClubIds: ProfileClubs.collection.find({ userId: Meteor.userId() }).fetch().map(membership => membership.clubId),
      interests: normalizeCategories(profile?.interests),
      friendClubIds: new Set(ProfileClubs.collection.find({ userId: { $in: acceptedIds } }).fetch().map(membership => membership.clubId)),
      ready: clubsSubscription.ready() && membershipSubscription.ready(),
    };
  }, []);

  const categories = useMemo(() => {
    const unique = new Set();
    clubs.forEach(club => normalizeCategories(club.categories).forEach(category => unique.add(category)));
    return [...unique].sort();
  }, [clubs]);

  // Most-used member tags across all clubs power the tag filter cloud.
  const popularTags = useMemo(() => {
    const counts = new Map();
    clubs.forEach(club => (club.tags || []).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([tag]) => tag);
  }, [clubs]);

  const scored = useMemo(() => {
    const context = { interests, friendClubIds };
    return clubs.map(club => {
      const score = scoreClub(club, context);
      const matchedInterest = interests.find(interest => normalizeCategories(club.categories)
        .concat(club.tags || [])
        .some(value => value.toLowerCase().includes(interest.toLowerCase()) || interest.toLowerCase().includes(value.toLowerCase())));
      return { club, score, tier: sizeTier(score), matchLabel: matchedInterest ? `For your ${matchedInterest} side` : '' };
    });
  }, [clubs, interests, friendClubIds]);

  const filtered = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const list = scored.filter(({ club }) => {
      const clubCategories = normalizeCategories(club.categories);
      const clubTags = club.tags || [];
      const matchesSearch = query === '' || [club.name, club.description, club.location, ...clubTags].some(value => (value || '').toLowerCase().includes(query));
      const matchesCategories = selectedCategories.length === 0 || clubCategories.some(category => selectedCategories.includes(category));
      const matchesTags = selectedTags.length === 0 || selectedTags.some(tag => clubTags.some(clubTag => clubTag.toLowerCase() === tag.toLowerCase()));
      return matchesSearch && matchesCategories && matchesTags;
    });
    if (sortMode === 'az') {
      return [...list].sort((a, b) => (a.club.name || '').localeCompare(b.club.name || ''));
    }
    return [...list].sort((a, b) => b.score - a.score);
  }, [scored, searchTerm, selectedCategories, selectedTags, sortMode]);

  useEffect(() => {
    setVisibleCount(PAGE_STEP + 6);
  }, [searchTerm, selectedCategories, selectedTags, sortMode]);

  // Lazy waterfall: grow the rendered window whenever the sentinel scrolls into view.
  // Re-observing after every growth matters: observe() always reports the current
  // intersection state, so loading continues even when new tiles didn't push the
  // sentinel out of the preload margin (otherwise no crossing event ever fires again).
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

  const addClubToProfile = clubId => {
    Meteor.call('profileClubs.add', clubId, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      }
    });
  };

  const toggleIn = (setter) => value => {
    setter(previous => (previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value]));
  };
  const toggleCategory = toggleIn(setSelectedCategories);
  const toggleTag = toggleIn(setSelectedTags);

  const clearFilters = () => {
    setSearchTerm('');
    setSelectedCategories([]);
    setSelectedTags([]);
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  const visible = filtered.slice(0, visibleCount);
  const hasFilters = searchTerm || selectedCategories.length > 0 || selectedTags.length > 0;

  return (
    <Container id="browse-clubs-page" className="page-shell py-4" fluid="xl">
      <div className="page-intro">
        <h1>Clubs</h1>
      </div>

      <div className="finder-layout">
        <aside className="filter-rail">
          <div className="filter-group">
            <div className="search-box" style={{ border: '1px solid var(--line)', borderRadius: 999 }}>
              <Search />
              <Form.Control
                type="text"
                placeholder="Search…"
                value={searchTerm}
                onChange={event => setSearchTerm(event.target.value)}
                className="search-input"
              />
            </div>
          </div>

          <div className="filter-group">
            <h4>Sort</h4>
            <div className="mode-toggle">
              <button type="button" className={sortMode === 'foryou' ? 'active' : ''} onClick={() => setSortMode('foryou')}>For you</button>
              <button type="button" className={sortMode === 'az' ? 'active' : ''} onClick={() => setSortMode('az')}>A–Z</button>
            </div>
          </div>

          {popularTags.length > 0 && (
            <div className="filter-group">
              <h4>Tags</h4>
              <div className="tag-cloud">
                {popularTags.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    className={`window-chip${selectedTags.includes(tag) ? ' active' : ''}`}
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="filter-group">
            <h4>Categories</h4>
            {categories.map(category => (
              <Form.Check
                key={category}
                type="checkbox"
                id={`filter-${category}`}
                checked={selectedCategories.includes(category)}
                onChange={() => toggleCategory(category)}
                label={category}
              />
            ))}
          </div>

          {hasFilters && (
            <Button type="button" className="btn-soft-primary" onClick={clearFilters}>Clear all</Button>
          )}
        </aside>

        <div>
          <div className="finder-count">{filtered.length} clubs{sortMode === 'foryou' && interests.length > 0 ? ' · sized to your interests' : ''}</div>

          {visible.length === 0 ? (
            <Alert className="empty-state-card">
              <h2>No matches.</h2>
              <Button type="button" onClick={clearFilters} className="btn-solid-primary">Reset</Button>
            </Alert>
          ) : (
            <div className="masonry">
              {visible.map(({ club, tier, matchLabel }) => (
                <motion.div key={club._id} className="masonry-item" variants={rise} initial="hidden" animate="show">
                  <Club
                    club={club}
                    tier={tier}
                    matchLabel={matchLabel}
                    isMember={joinedClubIds.includes(club._id)}
                    onAddToProfile={addClubToProfile}
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
