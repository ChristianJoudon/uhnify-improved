import React, { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { Accounts } from 'meteor/accounts-base';
import { Container } from 'react-bootstrap';
import PageHead from '../components/PageHead';
import { MIN_PASSWORD_LENGTH } from '../../api/listing/limits';

/** Where the reset mail's link lands. A good token signs the person in. */
const ResetPassword = () => {
  const { token } = useParams();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [trouble, setTrouble] = useState('');
  const [done, setDone] = useState(false);

  const submit = event => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setTrouble(`Pick a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== again) {
      setTrouble('Those two do not match.');
      return;
    }
    Accounts.resetPassword(token, password, error => {
      if (error) {
        setTrouble(error.reason === 'Token expired'
          ? 'That link has expired. Ask for a new one.'
          : (error.reason || error.message));
        return;
      }
      setDone(true);
    });
  };

  if (done) {
    return <Navigate to="/" replace />;
  }

  return (
    <Container id="reset-password" className="page-shell py-4">
      <div className="auth-shell">
        <PageHead title="Set a new password" />
        <form className="mb-panel auth-form" onSubmit={submit}>
          <label htmlFor="reset-password">
            <span className="mb-field-label">New password</span>
            <input id="reset-password" className="mb-field" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} minLength={MIN_PASSWORD_LENGTH} required />
          </label>
          <label htmlFor="reset-password-again">
            <span className="mb-field-label">Once more</span>
            <input id="reset-password-again" className="mb-field" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} required />
          </label>
          {trouble && <p className="auth-error" role="alert">{trouble}</p>}
          <div className="auth-actions">
            <button type="submit" className="btn btn-solid-primary form-controlsubmit">Save and sign in</button>
          </div>
        </form>
        <p className="auth-alt">
          Link not working? <Link to="/forgot-password">Ask for a new one</Link>
        </p>
      </div>
    </Container>
  );
};

export default ResetPassword;
