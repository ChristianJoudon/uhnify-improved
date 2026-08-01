import React from 'react';
import { Container, Spinner } from 'react-bootstrap';

const LoadingSpinner = () => (
  <Container className="loading-state text-center py-5">
    <Spinner animation="border" role="status" />
    <div className="mt-3 fw-semibold">One moment…</div>
  </Container>
);

export default LoadingSpinner;
