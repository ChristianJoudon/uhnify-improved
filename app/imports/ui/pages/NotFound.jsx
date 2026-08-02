import React from 'react';
import { Container } from 'react-bootstrap';
import { Compass } from 'react-bootstrap-icons';
import { Link } from 'react-router-dom';
import PageHead from '../components/PageHead';

/**
 * A 404 is still a page, so it opens the way every other page does. "Lost?" was
 * an h2 under no h1 at all, which left the route with no name in the document
 * outline or in a screen reader's heading list.
 */
const NotFound = () => (
  <Container className="page-shell page-notice py-5">
    <PageHead title="Lost?" />
    <div className="mb-empty">
      <Compass className="mb-empty-glyph" aria-hidden="true" />
      <h3>This page isn&apos;t on the map.</h3>
      <p>The link may be old, or off by a letter.</p>
      <Link className="btn btn-solid-primary" to="/">Take me home</Link>
    </div>
  </Container>
);

export default NotFound;
