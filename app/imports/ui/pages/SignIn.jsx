import React, { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { Container } from 'react-bootstrap';
import PageHead from '../components/PageHead';
import { takeReturnTo } from '../utilities/returnTo';

/**
 * The development accounts, when this is a development server that lists them.
 * Production never sees this: the key is absent from any production settings
 * file (productionGuard refuses to start otherwise), and the server-side
 * handler these buttons call is not registered outside development.
 */
const devAccounts = () => (
  Meteor.isDevelopment && Array.isArray(Meteor.settings.public?.devSignIn) ? Meteor.settings.public.devSignIn : []
);

const SignIn = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // Where to go once signed in; empty until then. It was a boolean and the
  // destination was always '/', which stranded anyone who had been sent here
  // on the way to somewhere — an invite link most of all.
  const [redirect, setRedirect] = useState('');

  // Taken in the callback, once, not during render: reading it clears it, and
  // a render can run twice.
  const arrive = () => setRedirect(takeReturnTo() || '/');

  const handleSubmit = event => {
    event.preventDefault();
    Meteor.loginWithPassword(email, password, err => {
      if (err) {
        setError(err.reason);
      } else {
        arrive();
      }
    });
  };

  // No password travels and none is typed: the server decides, from its own
  // settings and from where the request came from, whether to hand out the
  // session. See startup/server/devSignIn.js.
  const signInAs = address => {
    Accounts.callLoginMethod({
      methodArguments: [{ devSignIn: address }],
      userCallback: err => (err ? setError(err.reason || err.message) : arrive()),
    });
  };

  if (redirect) {
    return <Navigate to={redirect} replace />;
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
          New here? <Link to="/signup">Create an account</Link> · <Link to="/forgot-password">Forgot your password?</Link>
        </p>

        {devAccounts().length > 0 && (
          <section className="dev-sign-in" aria-labelledby="dev-sign-in-label">
            <h2 id="dev-sign-in-label">Development only</h2>
            <p>One click, no password. This panel does not exist on a production server.</p>
            <div className="dev-sign-in-actions">
              {devAccounts().map(address => (
                <button
                  key={address}
                  type="button"
                  className="btn btn-soft-primary"
                  data-dev-sign-in={address}
                  onClick={() => signInAs(address)}
                >
                  Sign in as {address}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </Container>
  );
};

export default SignIn;
