import React, { useMemo, useRef, useState } from 'react';
import { Container, Form } from 'react-bootstrap';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { useNavigate } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { Camera, Trash } from 'react-bootstrap-icons';
import PosterArt from '../components/PosterArt';
import PrivacyToggles from '../components/PrivacyToggles';
import LoadingSpinner from '../components/LoadingSpinner';
import { Clubs } from '../../api/club/Club';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { isOpenToAll } from '../../api/listing/audience';
import { isListingOwner } from '../../api/listing/ownership';
import { isAnonymousListing, isSensitiveListing } from '../../api/privacy/FriendActivityPrivacy';
import { formatEventDate } from '../utilities/helpers';
import { shrinkImage } from '../utilities/shrinkImage';
import { topicForEvent } from '../utilities/topics';
import { TEXT_LIMITS } from '../../api/listing/limits';

const AddEvent = () => {
  const navigate = useNavigate();
  const fileInput = useRef(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: '',
    hostId: '',
    date: '',
    location: '',
    description: '',
    email: '',
    image: '',
  });
  // The event's OWN privacy, once somebody has set any of it by hand. Until
  // then it is null and the event follows its host group — which is not a
  // default value but a different thing: the server stamps such an event
  // `privacyInherited`, and it goes on following the group afterwards.
  const [ownPrivacy, setOwnPrivacy] = useState(null);

  const { ready, myClubs, allClubs } = useTracker(() => {
    const clubsSub = Meteor.subscribe(Clubs.userPublicationName);
    const memberSub = Meteor.subscribe(ProfileClubs.membershipPublicationName);
    // The public directory has no private groups in it, by design — so with
    // that alone, the members of a private group could not post its Thursday
    // meeting: their own group was missing from "Hosted by". These two send a
    // person the groups they are in and the groups they run, private or not.
    const joinedSub = Meteor.subscribe(ProfileClubs.userPublicationName);
    const ownedSub = Meteor.subscribe('Clubs.publication.owned');
    const joinedIds = new Set(ProfileClubs.collection.find({ userId: Meteor.userId() }).fetch().map(m => m.clubId));
    const clubs = Clubs.collection.find({}, { sort: { name: 1 } }).fetch();
    return {
      ready: clubsSub.ready() && memberSub.ready() && joinedSub.ready() && ownedSub.ready(),
      myClubs: clubs.filter(club => joinedIds.has(club._id) || isListingOwner(Meteor.userId(), club)),
      allClubs: clubs,
    };
  }, []);

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));

  const host = useMemo(() => allClubs.find(club => club._id === form.hostId), [allClubs, form.hostId]);

  // What the host group says, read the way the server will read it when the
  // event is made. Shown in the switches while the event follows the group,
  // and the starting point the moment somebody moves one.
  const hostPrivacy = useMemo(() => ({
    visibility: host && !isOpenToAll(host) ? 'private' : 'public',
    anonymous: host?.anonymous === true,
  }), [host]);
  const privacy = ownPrivacy || hostPrivacy;
  // An anonymous group's meeting is anonymous: who goes says who belongs. The
  // event's own switch cannot change that, so it is drawn on and fixed.
  const anonymousLocked = Boolean(host) && isAnonymousListing(host);
  const lockedByHostChoice = anonymousLocked && !isSensitiveListing(host);
  // The server copies the selected host's categories onto the new event.
  // Preview that resulting record through the same authoritative resolver the
  // public card uses, so the color shown here is the color people will see.
  const topic = useMemo(
    () => topicForEvent({
      title: form.title,
      description: form.description,
      categories: host?.categories,
    }),
    [host, form.title, form.description],
  );

  const when = form.date ? formatEventDate(new Date(form.date)) : '';
  const valid = form.title.trim() && form.hostId && form.date && form.location.trim();

  const pickImage = async event => {
    const input = event.target;
    const file = input.files?.[0];
    // Clear it, or picking the same file after Remove fires no change event.
    // Held as a local first: assigning straight through `event.target` trips
    // no-param-reassign, a rule that exists to stop a handler mutating its
    // caller's data — and this is a deliberate write to a DOM node, not that.
    input.value = '';
    if (!file) {
      return;
    }
    try {
      // Shrunk here rather than refused: a phone photo is several megabytes,
      // and the 2 MB door that stood here turned real people away.
      set('image', await shrinkImage(file));
    } catch (error) {
      swal('Could not use that photo', error.message, 'error');
    }
  };

  const submit = event => {
    event.preventDefault();
    if (!valid || saving) {
      return;
    }
    setSaving(true);
    Meteor.call('Events.insert', {
      // The host is chosen from a list; the numeric id the schema wants is
      // looked up here rather than typed in by hand.
      eventID: host.clubID,
      title: form.title.trim(),
      description: form.description.trim(),
      date: new Date(form.date),
      location: form.location.trim(),
      // Blank means "publish none"; the server stores nothing for it.
      email: form.email.trim(),
      // Empty string, never undefined — see AddClub.
      image: form.image,
      // Both or neither. Neither is "follow the group", and the server marks
      // the event as doing so. Both, because the switches showed both: sending
      // only the one that was touched would leave the other to be filled in
      // out of sight, and what is stored should be what was on screen.
      ...(ownPrivacy ? { visibility: ownPrivacy.visibility, anonymous: ownPrivacy.anonymous } : {}),
    }, error => {
      setSaving(false);
      if (error) {
        swal('Could not create', error.reason || error.message, 'error');
        return;
      }
      // A private event is not on the public calendar, so its poster is sent
      // to the page that does list it rather than to one where it is missing.
      const isPrivate = privacy.visibility === 'private';
      swal(
        'Created',
        isPrivate
          ? `${form.title.trim()} is ready. Only ${host.name} can see it.`
          : `${form.title.trim()} is on the calendar.`,
        'success',
      ).then(() => navigate(isPrivate ? '/user-events' : '/upcoming-events'));
    });
  };

  // One key arrives at a time; the rest is whatever the switches were showing.
  const changePrivacy = patch => setOwnPrivacy({ ...privacy, ...patch });

  if (!ready) {
    return <LoadingSpinner />;
  }

  const hostOptions = myClubs.length > 0 ? myClubs : allClubs;

  return (
    <Container id="add-events" className="page-shell py-4">
      <div className="page-intro">
        <h1>Start an event</h1>
        <p>One-off happenings. For something recurring, start a group instead.</p>
      </div>

      <div className="create-layout">
        <aside className="create-preview">
          <span className="create-preview-label">Preview</span>
          <div className="mb-poster mb-poster-lg">
            <PosterArt
              topic={topic}
              eyebrow={when}
              title={form.title}
              tagline={form.description}
              image={form.image}
              placeholder="Your event name"
            />
            <div className="mb-poster-foot">
              <span className="mb-poster-meta">
                {form.location || 'Where it happens'}
                <em>{host ? host.name : (topic.activityLabel || topic.label)}</em>
              </span>
            </div>
          </div>
          <p className="field-hint mt-2">This is the card people swipe in Match.</p>
        </aside>

        <form className="create-form" onSubmit={submit}>
          <section className="form-block">
            <h3>The basics</h3>
            <label htmlFor="title">
              Name
              <input
                id="title"
                type="text"
                value={form.title}
                maxLength={TEXT_LIMITS.title}
                placeholder="Sunset Movie Night"
                onChange={e => set('title', e.target.value)}
                required
              />
            </label>

            <label htmlFor="eventID">
              Hosted by
              <select id="eventID" value={form.hostId} onChange={e => set('hostId', e.target.value)} required>
                <option value="">Choose a group…</option>
                {hostOptions.map(club => (
                  <option key={club._id} value={club._id}>{club.name}</option>
                ))}
              </select>
            </label>
            <span className="field-hint">
              {myClubs.length > 0 ? 'Groups you belong to or run.' : 'Join a group and it will appear here first.'}
            </span>

            <div className="field-row">
              <label htmlFor="date">
                When
                <input
                  id="date"
                  type="datetime-local"
                  value={form.date}
                  onChange={e => set('date', e.target.value)}
                  required
                />
              </label>
              <label htmlFor="location">
                Where
                <input
                  id="location"
                  type="text"
                  value={form.location}
                  maxLength={TEXT_LIMITS.location}
                  placeholder="Rooftop, 3rd floor"
                  onChange={e => set('location', e.target.value)}
                  required
                />
              </label>
            </div>
          </section>

          <section className="form-block">
            <h3>Details</h3>
            <label htmlFor="description">
              What to expect
              <textarea
                id="description"
                rows={3}
                value={form.description}
                maxLength={TEXT_LIMITS.description}
                placeholder="What happens, what to bring, who it's for."
                onChange={e => set('description', e.target.value)}
              />
            </label>
          </section>

          <section className="form-block">
            <h3>Photo</h3>
            <div className="photo-row">
              <button type="button" className="btn btn-soft-primary" onClick={() => fileInput.current.click()}>
                <Camera /> {form.image ? 'Replace photo' : 'Add a photo'}
              </button>
              {form.image && (
                <button type="button" className="btn btn-outline-danger-soft" onClick={() => set('image', '')}>
                  <Trash /> Remove
                </button>
              )}
              <Form.Control ref={fileInput} type="file" accept="image/*" onChange={pickImage} className="d-none" />
            </div>
            <span className="field-hint">Optional — without one we design a poster from the host&apos;s topic.</span>
          </section>

          <section className="form-block">
            <h3>Contact</h3>
            <label htmlFor="email">
              Contact email
              <input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="off"
                value={form.email}
                maxLength={TEXT_LIMITS.email}
                placeholder="hello@yourgroup.org"
                onChange={e => set('email', e.target.value)}
                aria-describedby="email-hint"
              />
            </label>
            {/* The one thing on this form that is printed for strangers on the
                organizer's say-so, so the form says so. Nothing else about the
                poster — not their account — ever reaches the card. */}
            <span className="field-hint" id="email-hint">
              Optional — printed on the event&apos;s card for anyone to see, so people can reach you.
            </span>
          </section>

          {/* Last, and a card of its own, as on the group form. An event starts
              out following its group — an anonymous group's meeting is
              anonymous without the organizer remembering to say so every
              Thursday — and says that it is, until a switch is moved. */}
          <section className="form-block" aria-labelledby="add-event-privacy">
            <h3 id="add-event-privacy">Privacy</h3>
            <PrivacyToggles
              kind="event"
              idPrefix="add-event"
              value={privacy}
              anonymousLocked={anonymousLocked}
              lockedHelp={lockedByHostChoice ? `Always on, because ${host.name} is anonymous.` : ''}
              following={host && !ownPrivacy ? host.name : ''}
              onFollow={host && ownPrivacy ? () => setOwnPrivacy(null) : null}
              onChange={changePrivacy}
            />
          </section>

          <div className="create-actions">
            <button id="submit" type="submit" className="btn btn-solid-primary" disabled={!valid || saving}>
              {saving ? 'Creating…' : 'Create event'}
            </button>
            {!valid && <span className="field-hint">Name, host, when, and where.</span>}
          </div>
        </form>
      </div>
    </Container>
  );
};

export default AddEvent;
