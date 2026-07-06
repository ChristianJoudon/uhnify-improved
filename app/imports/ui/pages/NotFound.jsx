import React from 'react';
import { Button, Col, Container, Row } from 'react-bootstrap';
import { Link } from 'react-router-dom';

const NotFound = () => (
  <Container className="page-shell py-5">
    <Row className="justify-content-center">
      <Col md={6} className="text-center">
        <div className="empty-state-card">
          <span className="deck-empty-emoji" role="img" aria-label="compass">🧭</span>
          <h2 className="mb-3">Lost?</h2>
          <Button as={Link} to="/" className="btn-solid-primary">Home</Button>
        </div>
      </Col>
    </Row>
  </Container>
);

export default NotFound;
