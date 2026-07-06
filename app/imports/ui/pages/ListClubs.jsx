import React, { useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Alert, Button, Col, Container, Row } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import swal from 'sweetalert';
import { motion } from 'framer-motion';
import { Clubs } from '../../api/club/Club';
import Club2 from '../components/Club2';
import ClubDetailsModal from '../components/ClubDetailsModal';
import LoadingSpinner from '../components/LoadingSpinner';
import { ProfileClubs } from '../../api/profile/ProfileClubs';

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: index => ({ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 180, damping: 22, delay: Math.min(index, 8) * 0.05 } }),
};

const ListClub = () => {
  const [showModal, setShowModal] = useState(false);
  const [selectedClub, setSelectedClub] = useState(null);

  const { ready, clubs } = useTracker(() => {
    const subscription = Meteor.subscribe(ProfileClubs.userPublicationName);
    return {
      clubs: Clubs.collection.find({}, { sort: { name: 1 } }).fetch(),
      ready: subscription.ready(),
    };
  }, []);

  const onRemoveFromProfile = clubId => {
    Meteor.call('profileClubs.remove', clubId, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal('Removed', 'Club removed from My Clubs.', 'success');
      }
    });
  };

  if (!ready) {
    return <LoadingSpinner />;
  }

  return (
    <Container id="list-clubs" className="page-shell py-4">
      <div className="page-intro">
        <h1>My clubs</h1>
      </div>

      {clubs.length === 0 ? (
        <Alert className="empty-state-card text-center">
          <h2>No clubs yet.</h2>
          <Button as={Link} to="/search-clubs" className="btn-solid-primary">Browse clubs</Button>
        </Alert>
      ) : (
        <Row xs={1} md={2} xl={3} className="g-4">
          {clubs.map((club, index) => (
            <Col key={club._id}>
              <motion.div variants={rise} initial="hidden" animate="show" custom={index} className="h-100">
                <Club2
                  club={club}
                  onRemoveFromProfile={onRemoveFromProfile}
                  onViewDetails={() => {
                    setSelectedClub(club);
                    setShowModal(true);
                  }}
                />
              </motion.div>
            </Col>
          ))}
        </Row>
      )}
      <ClubDetailsModal show={showModal} handleClose={() => setShowModal(false)} club={selectedClub} />
    </Container>
  );
};

export default ListClub;
