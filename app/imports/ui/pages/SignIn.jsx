import React, { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Meteor } from 'meteor/meteor';
import { Container } from 'react-bootstrap';
import PageHead from '../components/PageHead';

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
    <Container id="sign-in" className="page-shell py-4">
      <div className="auth-shell">
        {/* The one gesture the product is named for. Decorative — the
            heading under it already says where you are. */}
        <img className="auth-mark" src="/images/art-strike.webp" alt="" width="300" height="562" />
        <PageHead title="Sign in">Pick up where you left off.</PageHead>

        <form className="mb-panel auth-form" onSubmit={handleSubmit}>
          <label id="form-email" htmlFor="formBasicEmail">
            <span className="mb-field-label">Email</span>
            <input
              id="formBasicEmail"
              className="mb-field form-controltextbox"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
          </label>

          <label id="form-password" htmlFor="formBasicPassword">
            <span className="mb-field-label">Password</span>
            <input
              id="formBasicPassword"
              className="mb-field form-controltextbox"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={event => setPassword(event.target.value)}
            />
          </label>

          {/* Announced next to the button the user is about to press again,
              not at the top of a page they have already scrolled past. */}
          {error && <p className="auth-error" role="alert">{error}</p>}

          <div className="auth-actions">
            <button type="submit" className="btn btn-solid-primary form-controlsubmit">Sign in</button>
          </div>
        </form>

        <p className="auth-alt">
          New here? <Link to="/signup">Create an account</Link>
        </p>
      </div>
    </Container>
  );
};

export default SignIn;
