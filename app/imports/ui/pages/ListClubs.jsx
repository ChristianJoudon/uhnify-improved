import React, { useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import swal from 'sweetalert';
import { motion } from 'framer-motion';
import { Collection, DoorOpen } from 'react-bootstrap-icons';
import { Clubs } from '../../api/club/Club';
import Club from '../components/Club';
import DetailsModal from '../components/DetailsModal';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { scoreClub, sizeTier } from '../utilities/recommend';
import { KAUAI, milesLabel, milesTo } from '../utilities/geo';

const rise = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] } },
};

const ListClub = () => {
  const [showModal, setShowModal] = useState(false);
  const [selectedClub, setSelectedClub] = useState(null);

  const { ready, clubs } = useTracker(() => {
    const clubsSub = Meteor.subscribe(ProfileClubs.userPublicationName);
    // That publication works out which groups to send once, when it starts, so
    // a group the person leaves stays in its cursor: Leave said it had worked
    // and the card sat there until the next page load. Memberships are a live
    // cursor. The wall is the groups both agree on, so a card goes the moment
    // its membership does — and a group some other page left in minimongo
    // cannot wander onto a list of groups you are in.
    const membershipsSub = Meteor.subscribe(ProfileClubs.membershipPublicationName);
    const joinedIds = ProfileClubs.collection.find({ userId: Meteor.userId() })
      .map(membership => membership.clubId);
    return {
      clubs: Clubs.collection.find({ _id: { $in: joinedIds } }, { sort: { name: 1 } }).fetch(),
      ready: clubsSub.ready() && membershipsSub.ready(),
    };
  }, []);

  const leave = club => {
    Meteor.call('profileClubs.remove', club._id, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal({ text: `You've left ${club.name}.`, icon: 'success' });
      }
    });
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="list-clubs" className="page-shell py-4">
      {/* Nothing sits beside the title when the page is empty — the empty state
          owns the invitation, and two of them would compete. */}
      <PageHead
        title="My groups"
        action={clubs.length > 0 ? <Link to="/search-clubs" className="btn btn-soft-primary">Find more</Link> : null}
      >
        {clubs.length > 0 ? `${clubs.length} ${clubs.length === 1 ? 'group' : 'groups'} you're in.` : null}
      </PageHead>

      {clubs.length === 0 ? (
        <div className="mb-empty">
          <Collection className="mb-empty-glyph" aria-hidden="true" />
          <h3>No groups yet</h3>
          <p>Groups you join land here, so the ones you care about stay one tap away.</p>
          <Link to="/search-clubs" className="btn btn-match">Find groups</Link>
        </div>
      ) : (
        <div className="masonry">
          {clubs.map(club => (
            <motion.div key={club._id} className="masonry-item" variants={rise} initial="hidden" animate="show">
              {/* The entrance animation owns the motion element's transform, so
                  the hover lift needs a wrapper of its own — and that wrapper is
                  also what the Leave button is positioned against. */}
              <div className="saved-poster">
                {/* The same object the finder shows, so a club you joined is not
                    a different species from the club you joined it from. With no
                    interests subscribed here the score is pure jitter, which is
                    exactly what sizeTier falls back on for variety. */}
                <Club
                  club={club}
                  tier={sizeTier(scoreClub(club))}
                  distance={milesLabel(milesTo(club, KAUAI))}
                  isMember
                  onViewDetails={() => {
                    setSelectedClub(club);
                    setShowModal(true);
                  }}
                />
                {/* Everything here is already joined, so the poster's join button
                    is a dead control. It stays as an invisible spacer holding the
                    footer's right-hand slot open, and Leave takes that slot. */}
                <button
                  type="button"
                  className="btn btn-outline-danger-soft mb-poster-cta saved-leave"
                  onClick={() => leave(club)}
                >
                  <DoorOpen size={14} aria-hidden="true" />
                  Leave
                  <span className="visually-hidden">{` ${club.name}`}</span>
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      )}
      <DetailsModal show={showModal} onHide={() => setShowModal(false)} record={selectedClub} kind="club" />
    </Container>
  );
};

export default ListClub;
