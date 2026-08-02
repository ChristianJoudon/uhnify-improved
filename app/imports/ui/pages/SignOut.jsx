import React from 'react';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import PageHead from '../components/PageHead';

/**
 * Signing out is still a page. This one had no h1 at all — a bare "Signed out."
 * with nothing naming the route in the document outline or in a screen
 * reader's heading list.
 */
const SignOut = () => {
  Meteor.logout();
  return (
    <Container id="signout-page" className="page-shell py-4">
      <div className="auth-shell">
        <PageHead title="Signed out">See you soon.</PageHead>
        <div className="mb-panel auth-done">
          <span className="auth-done-glyph" role="img" aria-label="Waving hand">👋</span>
          <p>Your clubs, your saves and everything you said yes to are still here.</p>
          <Link to="/signin" className="btn btn-solid-primary">Sign back in</Link>
        </div>
      </div>
    </Container>
  );
};

export default SignOut;
