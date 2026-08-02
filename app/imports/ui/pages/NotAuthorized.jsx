import React from 'react';
import { Container } from 'react-bootstrap';
import { ShieldLock } from 'react-bootstrap-icons';
import { Link } from 'react-router-dom';
import PageHead from '../components/PageHead';

/**
 * Reached when a signed-in account hits an admin route, so the copy points at
 * the account rather than at signing in — the visitor is already signed in.
 */
const NotAuthorized = () => (
  <Container className="page-shell page-notice py-5">
    <PageHead title="Members only." />
    <div className="mb-empty">
      <ShieldLock className="mb-empty-glyph" aria-hidden="true" />
      <h3>You don&apos;t have access to this one.</h3>
      <p>Ask an admin to check your account if that seems wrong.</p>
      <Link className="btn btn-solid-primary" to="/">Take me home</Link>
    </div>
  </Container>
);

export default NotAuthorized;
