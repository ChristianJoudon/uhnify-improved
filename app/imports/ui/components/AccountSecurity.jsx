import React, { useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { useTracker } from 'meteor/react-meteor-data';
import { useNavigate } from 'react-router-dom';
import swal from 'sweetalert';
import { MIN_PASSWORD_LENGTH } from '../../api/listing/limits';

/**
 * The account itself, on the Settings page: whether the address is confirmed,
 * a way to change the password, and a way out. Kept apart from the profile
 * form because none of this is saved by its Save button.
 */
const AccountSecurity = () => {
  const navigate = useNavigate();
  const { address, verified } = useTracker(() => {
    const entry = Meteor.user()?.emails?.[0];
    return { address: entry?.address, verified: Boolean(entry?.verified) };
  });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const resend = () => Meteor.call('accounts.resendVerification', (error, result) => (error
    ? swal('Not sent', error.reason || error.message, 'error')
    : swal(result === 'sent' ? 'Sent' : 'Already confirmed', result === 'sent' ? `Check ${address}.` : 'Nothing to do.', 'success')));

  const changePassword = event => {
    event.preventDefault();
    if (next.length < MIN_PASSWORD_LENGTH) {
      swal('Too short', `At least ${MIN_PASSWORD_LENGTH} characters.`, 'error');
      return;
    }
    Accounts.changePassword(current, next, error => {
      if (error) {
        swal('Not changed', error.reason || error.message, 'error');
        return;
      }
      setCurrent('');
      setNext('');
      swal('Changed', 'Your password is updated.', 'success');
    });
  };

  const deleteAccount = event => {
    event.preventDefault();
    swal({
      title: 'Delete your account?',
      text: 'Your profile, plans, friendships and history go for good. Anything you posted for others stays up without your name on it.',
      buttons: ['Keep it', 'Delete my account'],
      dangerMode: true,
    }).then(yes => yes && Meteor.call('accounts.deleteMine', Accounts._hashPassword(confirm), error => {
      if (error) {
        swal('Not deleted', error.reason || error.message, 'error');
        return;
      }
      Meteor.logout(() => navigate('/'));
    }));
  };

  return (
    <>
      <section className="form-block" aria-labelledby="account-email-heading">
        <h3 id="account-email-heading">Your email</h3>
        <p className="field-hint">
          {address}{verified ? ' — confirmed.' : ' — not confirmed yet. You need to confirm it before you can post.'}
        </p>
        {!verified && (
          <button type="button" className="btn btn-soft-primary" onClick={resend}>Send the confirmation again</button>
        )}
      </section>

      <form className="form-block" onSubmit={changePassword} aria-labelledby="account-password-heading">
        <h3 id="account-password-heading">Password</h3>
        <label htmlFor="current-password">
          Current password
          <input id="current-password" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} required />
        </label>
        <label htmlFor="new-password">
          New password
          <input id="new-password" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} minLength={MIN_PASSWORD_LENGTH} required />
        </label>
        <button type="submit" className="btn btn-soft-primary">Change password</button>
      </form>

      <form className="form-block" onSubmit={deleteAccount} aria-labelledby="account-delete-heading">
        <h3 id="account-delete-heading">Delete your account</h3>
        <p className="field-hint">Type your password to confirm. This cannot be undone.</p>
        <label htmlFor="delete-password">
          Password
          <input id="delete-password" type="password" autoComplete="current-password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
        </label>
        <button type="submit" className="btn btn-outline-danger-soft">Delete my account</button>
      </form>
    </>
  );
};

export default AccountSecurity;
