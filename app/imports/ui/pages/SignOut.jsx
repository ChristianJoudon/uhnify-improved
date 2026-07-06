import React from 'react';
import { Meteor } from 'meteor/meteor';
import { Button, Col, Container, Row } from 'react-bootstrap';
import { Link } from 'react-router-dom';

const SignOut = () => {
  Meteor.logout();
  return (
    <Container id="signout-page" className="page-shell py-5">
      <Row className="justify-content-center">
        <Col md={6} className="text-center">
          <div className="empty-state-card">
            <span className="deck-empty-emoji" role="img" aria-label="wave">👋</span>
            <h2>Signed out.</h2>
            <Button as={Link} to="/signin" className="btn-solid-primary">Sign back in</Button>
          </div>
        </Col>
      </Row>
    </Container>
  );
};

export default SignOut;
