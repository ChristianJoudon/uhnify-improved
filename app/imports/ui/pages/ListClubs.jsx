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
import { isListingOwner } from '../../api/listing/ownership';
import { joinGroupAndTell } from '../utilities/joinGroup';
import { scoreClub, sizeTier } from '../utilities/recommend';
import { KAUAI, milesLabel, milesTo } from '../utilities/geo';

const rise = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] } },
};

const ListClub = () => {
  const [showModal, setShowModal] = useState(false);
  const [selectedClub, setSelectedClub] = useState(null);

  const { ready, clubs, joinedIds } = useTracker(() => {
    const userId = Meteor.userId();
    const clubsSub = Meteor.subscribe(ProfileClubs.userPublicationName);
    // The wall is drawn from the memberships, not from whatever groups happen
    // to be in the browser's copy of the collection: a card goes the moment
    // its membership does, and a group some other page left in minimongo
    // cannot wander onto a list of groups you are in.
    const membershipsSub = Meteor.subscribe(ProfileClubs.membershipPublicationName);
    // The groups this person RUNS, in it or not. Starting a group does not
    // join it, and an owner can leave one like anybody else — and for a
    // private group that was the end of it: in no directory, on no list, its
    // settings page reachable only by remembering the address. This is the
    // one publication that carries `owner`, which is how a card knows to
    // offer "Manage".
    const ownedSub = Meteor.subscribe('Clubs.publication.owned');
    const joined = ProfileClubs.collection.find({ userId }).map(membership => membership.clubId);
    const mine = Clubs.collection.find({}, { sort: { name: 1 } }).fetch()
      .filter(club => joined.includes(club._id) || isListingOwner(userId, club));
    return {
      clubs: mine,
      joinedIds: new Set(joined),
      ready: clubsSub.ready() && membershipsSub.ready() && ownedSub.ready(),
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

  const runsOneFromOutside = clubs.some(club => !joinedIds.has(club._id));
  const summary = `${clubs.length} ${clubs.length === 1 ? 'group' : 'groups'} you're in${runsOneFromOutside ? ' or run' : ''}.`;

  return (
    <Container id="list-clubs" className="page-shell py-4">
      {/* Nothing sits beside the title when the page is empty — the empty state
          owns the invitation, and two of them would compete. */}
      <PageHead
        title="My groups"
        action={clubs.length > 0 ? <Link to="/search-clubs" className="btn btn-soft-primary">Find more</Link> : null}
      >
        {clubs.length > 0 ? summary : null}
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
          {clubs.map(club => {
            const joined = joinedIds.has(club._id);
            const poster = (
              // The same object the finder shows, so a club you joined is not
              // a different species from the club you joined it from. With no
              // interests subscribed here the score is pure jitter, which is
              // exactly what sizeTier falls back on for variety.
              <Club
                club={club}
                tier={sizeTier(scoreClub(club))}
                distance={milesLabel(milesTo(club, KAUAI))}
                isMember={joined}
                onAddToProfile={joinGroupAndTell}
                onViewDetails={() => {
                  setSelectedClub(club);
                  setShowModal(true);
                }}
              />
            );
            return (
              <motion.div key={club._id} className="masonry-item" variants={rise} initial="hidden" animate="show">
                {joined ? (
                  // The entrance animation owns the motion element's transform,
                  // so the hover lift needs a wrapper of its own — and that
                  // wrapper is also what the Leave button is positioned against.
                  <div className="saved-poster">
                    {poster}
                    {/* A group already joined makes the poster's join button a
                        dead control. It stays as an invisible spacer holding the
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
                ) : (
                  // A group this person runs and is not in. Its own "Join" is
                  // live — the owner walks in without a link — and there is
                  // nothing to leave.
                  poster
                )}
                {/* Outside the wrapper: Leave is pinned to the wrapper's bottom
                    edge, and a line added inside would move that edge. */}
                {isListingOwner(Meteor.userId(), club) && (
                  <Link className="mb-section-link mb-manage-link" to={`/manage/group/${club._id}`}>
                    Manage
                    <span className="visually-hidden">{` ${club.name}`}</span>
                  </Link>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
      <DetailsModal show={showModal} onHide={() => setShowModal(false)} record={selectedClub} kind="club" />
    </Container>
  );
};

export default ListClub;
