import React, { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Meteor } from 'meteor/meteor';
import { Button, Col, Container, Form, Row } from 'react-bootstrap';
import { Lock, Mailbox } from 'react-bootstrap-icons';

const SignIn = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [redirect, setRedirect] = useState(false);

  const handleSubmit = event => {
    event.preventDefault();
    Meteor.loginWithPassword(email, password, err => {
      if (err) {
        setError(err.reason);
      } else {
        setRedirect(true);
      }
    });
  };

  if (redirect) {
    return <Navigate to="/" />;
  }

  return (
    <Container id="sign-in" fluid className="auth-page">
      <Row className="min-vh-100 g-0">
        <Col lg={7} className="auth-form-panel">
          <Form onSubmit={handleSubmit} className="auth-card">
            <h1>Sign in</h1>
            <Form.Group id="form-email" controlId="formBasicEmail">
              <Form.Label>Email</Form.Label>
              <div className="input-with-icon">
                <Mailbox />
                <Form.Control className="form-controltextbox" type="email" placeholder="Email" value={email} onChange={event => setEmail(event.target.value)} />
              </div>
            </Form.Group>
            <Form.Group id="form-password" controlId="formBasicPassword">
              <Form.Label>Password</Form.Label>
              <div className="input-with-icon">
                <Lock />
                <Form.Control className="form-controltextbox" type="password" placeholder="Password" value={password} onChange={event => setPassword(event.target.value)} />
              </div>
            </Form.Group>
            <Button variant="primary" type="submit" className="form-controlsubmit btn-solid-primary">
              Sign in
            </Button>
            {error && <div className="auth-error">{error}</div>}
          </Form>
        </Col>
        <Col lg={5} className="auth-side-panel">
          <div>
            <h2>New here?</h2>
            <Button variant="outline-light" as={Link} to="/signup" className="form-controlsignup">Create account</Button>
          </div>
        </Col>
      </Row>
    </Container>
  );
};

export default SignIn;
