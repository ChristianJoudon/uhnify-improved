import React, { useEffect, useRef, useState } from 'react';
import { Container } from 'react-bootstrap';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { Link, useParams } from 'react-router-dom';
import { useTracker } from 'meteor/react-meteor-data';
import { Roles } from 'meteor/alanning:roles';
import { Camera, Trash } from '../utilities/icons';
import PageHead from '../components/PageHead';
import PosterArt from '../components/PosterArt';
import ChipInput from '../components/form/ChipInput';
import SchedulePicker from '../components/form/SchedulePicker';
import LoadingSpinner from '../components/LoadingSpinner';
import { Clubs } from '../../api/club/Club';
import { imagePath, isPhoto, normalizeCategories } from '../utilities/helpers';
import { shrinkImage } from '../utilities/shrinkImage';
import { topicFor } from '../utilities/topics';
import { normalizeSchedule, parseMeetingTime, scheduleLabel } from '../../api/club/schedule';
import { TEXT_LIMITS } from '../../api/listing/limits';

/**
 * The same screen as Start a group, pointed at a club that already exists.
 * Editing and creating one object used to be two different applications — an
 * AutoForm in a narrow column here, a live poster and real pickers there.
 *
 * Deliberately unlike Start a group in one place, because this form repairs
 * seeded data rather than authoring new copy: the categories stay free text,
 * since the finder's department index files clubs by those literal strings
 * and the eight-topic picker would quietly unfile them. The length caps are
 * the server's own, from TEXT_LIMITS, and they are generous — real
 * descriptions run past a thousand characters and still fit.
 */
const EditClubAdmin = () => {
  const { _id } = useParams();
  const fileInput = useRef(null);
  const seededFor = useRef(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const { doc, isAdmin, ready } = useTracker(() => {
    // Two ways to be allowed here: an administrator, who is sent every group,
    // or the person who runs this one, who is sent their own. Both carry
    // `owner`, which no public publication does — so a record without it came
    // from a wall, and whoever is looking at it may not edit it.
    const subscription = Meteor.subscribe(Clubs.adminPublicationName);
    const owned = Meteor.subscribe('Clubs.publication.owned');
    const found = Clubs.collection.findOne(_id);
    return {
      doc: found?.owner ? found : null,
      isAdmin: Roles.userIsInRole(Meteor.userId(), 'admin'),
      ready: subscription.ready() && owned.ready(),
    };
  }, [_id]);

  // Seeded once per club, not on every doc change: the subscription is live, so
  // re-seeding would wipe whatever is half-typed the moment the save echoes
  // back. Keyed on the route id, because React keeps this component mounted
  // when one edit route replaces another.
  useEffect(() => {
    if (doc && seededFor.current !== _id) {
      seededFor.current = _id;
      setForm({
        name: doc.name || '',
        owner: doc.owner || '',
        description: doc.description || '',
        location: doc.location || '',
        contactInfo: doc.contactInfo || '',
        image: doc.image || '',
        meetingTime: doc.meetingTime || '',
        categories: normalizeCategories(doc.categories),
        tags: doc.tags || [],
        // Clubs older than the structured schedule carry their meeting only as
        // text, so it is read back through the parser the server itself uses.
        // A stored one goes through the validator first: the field is a
        // blackbox, and the picker should open on what the calendar draws, not
        // on whatever an older version left there. A monthly schedule with no
        // weeks comes through as exactly that, and the picker asks which week.
        schedule: normalizeSchedule(doc.schedule) || parseMeetingTime(doc.meetingTime) || { days: [], time: '17:00', cadence: 'weekly' },
      });
    }
  }, [doc, _id]);

  if (!ready) {
    return <LoadingSpinner />;
  }

  // "Not there" is not "not loaded yet". Once the subscription is ready and the
  // record still is not, this used to sit on the spinner forever — an admin who
  // deletes something and then opens an old edit link saw a hung page.
  if (!doc) {
    return (
      <Container id="edit-missing" className="page-shell py-4">
        <div className="mb-empty">
          <h3>That group is not here any more.</h3>
          <p>It may have been deleted since this link was made.</p>
          <Link className="btn btn-solid-primary" to="/admin">Back to the dashboard</Link>
        </div>
      </Container>
    );
  }

  // One frame where the record has arrived but the effect that seeds `form` has
  // not run yet; reading form.* here would throw.
  if (!form || seededFor.current !== _id) {
    return <LoadingSpinner />;
  }

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));

  // The picker owns the meeting text. The method re-derives the structured
  // schedule from that text, and parseMeetingTime reads scheduleLabel's own
  // wording back, so one control keeps both fields honest.
  const setSchedule = value => setForm(current => ({
    ...current,
    schedule: value,
    meetingTime: scheduleLabel(value) || 'Schedule to come',
  }));

  // Resolved from the same sources in the same order as the saved poster, so
  // the preview's colour is the colour the wall will show.
  const topic = topicFor(form.categories, form.tags, form.name, form.description);
  const when = scheduleLabel(form.schedule) || form.meetingTime;
  // Only a genuinely uploaded photo becomes the poster face — the seeded logo
  // art stays the small footer mark, exactly as the club card decides it.
  const photo = isPhoto(form.image) ? form.image : '';
  const valid = form.name.trim() && form.description.trim() && form.location.trim() && form.owner.trim();

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
    // The payload is built key by key: the method's check() pattern rejects
    // anything it did not ask for, including _id. It would take a schedule and
    // is deliberately not sent one. Once the picker has been touched the
    // meeting text IS the schedule's label, weeks and end time included, and
    // the method reads that back into the schedule that wrote it. Left alone,
    // an older group's text is read again by today's parser, which is how a
    // schedule an earlier parser got wrong is put right by an ordinary save.
    Meteor.call('Clubs.update', _id, {
      clubID: doc.clubID,
      name: form.name.trim(),
      owner: form.owner.trim(),
      description: form.description.trim(),
      location: form.location.trim(),
      image: form.image,
      // Required by the schema, so a club that arrived without meeting text
      // cannot be saved back with none.
      meetingTime: form.meetingTime || 'Schedule to come',
      contactInfo: form.contactInfo.trim(),
      categories: form.categories.join(', '),
      tags: form.tags,
    }, error => {
      setSaving(false);
      if (error) {
        swal('Error', error.reason || error.message, 'error');
      } else {
        swal('Saved', 'That group is up to date.', 'success');
      }
    });
  };

  return (
    <Container id="edit-club" className="page-shell py-4">
      <PageHead
        title="Edit group"
        eyebrow="Admin"
        action={<Link className="btn btn-soft-primary" to={isAdmin ? '/admin' : `/manage/group/${_id}`}>{isAdmin ? 'All groups' : 'Back'}</Link>}
      >
        Saved changes are live on the wall straight away.
      </PageHead>

      <div className="create-layout">
        <aside className="create-preview">
          <span className="create-preview-label">Preview</span>
          <div className="mb-poster mb-poster-lg">
            <PosterArt
              topic={topic}
              eyebrow={when}
              title={form.name}
              tagline={form.description}
              image={photo}
              placeholder="This group"
            />
            <div className="mb-poster-foot">
              {form.image && <img className="mb-poster-mark" src={imagePath(form.image)} alt="" />}
              <span className="mb-poster-meta">
                {form.location || 'Where you meet'}
                <em>{topic.activityLabel || topic.label}</em>
              </span>
            </div>
          </div>
          <p className="field-hint mt-2">This is how it appears in Nearby.</p>
        </aside>

        <form className="create-form" onSubmit={submit}>
          <section className="form-block">
            <h3>The basics</h3>
            <label htmlFor="name">
              Name
              <input
                id="name"
                type="text"
                value={form.name}
                maxLength={TEXT_LIMITS.name}
                onChange={e => set('name', e.target.value)}
                required
              />
            </label>

            <label htmlFor="description">
              What it&apos;s about
              <textarea
                id="description"
                rows={6}
                value={form.description}
                maxLength={TEXT_LIMITS.description}
                onChange={e => set('description', e.target.value)}
                required
              />
            </label>

            <label htmlFor="location">
              Where you meet
              <input
                id="location"
                type="text"
                value={form.location}
                maxLength={TEXT_LIMITS.location}
                onChange={e => set('location', e.target.value)}
                required
              />
            </label>
            {/* The number is this club's identity across the events data and is
                never rewritten, so it is stated rather than offered. */}
            <span className="field-hint">Group #{doc.clubID}</span>
          </section>

          <section className="form-block">
            <h3>When you meet</h3>
            <SchedulePicker value={form.schedule} onChange={setSchedule} />
            <span className="field-hint">Saved as “{form.meetingTime || 'Schedule to come'}”.</span>
          </section>

          <section className="form-block">
            <h3>How it&apos;s filed</h3>
            <p className="form-note">Categories place it in the directory. Tags are the words members search for.</p>
            <label className="field-label" htmlFor="categories">Categories</label>
            <ChipInput
              id="categories"
              values={form.categories}
              onChange={value => set('categories', value)}
              placeholder="Sports, Team Sports…"
            />

            <div className="mt-3">
              <label className="field-label" htmlFor="tags">Tags</label>
              <ChipInput
                id="tags"
                values={form.tags}
                onChange={value => set('tags', value)}
                placeholder="board games, beginners welcome…"
              />
            </div>
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
              <input ref={fileInput} type="file" accept="image/*" onChange={pickImage} className="d-none" />
            </div>
            <span className="field-hint">Only an uploaded photo becomes the poster face; seeded art stays the small mark.</span>
          </section>

          <section className="form-block">
            <h3>Who runs it</h3>
            {/* Handing a group to somebody else is an administrator's call;
                the server keeps the owner it had for anyone else. */}
            {isAdmin && (
              <label htmlFor="owner">
                Owner
                <input
                  id="owner"
                  type="text"
                  value={form.owner}
                  maxLength={TEXT_LIMITS.email}
                  onChange={e => set('owner', e.target.value)}
                  required
                />
              </label>
            )}

            <label htmlFor="contactInfo">
              How people reach them
              <input
                id="contactInfo"
                type="text"
                value={form.contactInfo}
                maxLength={TEXT_LIMITS.contactInfo}
                placeholder="hello@yourgroup.org"
                onChange={e => set('contactInfo', e.target.value)}
              />
            </label>
          </section>

          <div className="create-actions">
            <button id="submit" type="submit" className="btn btn-solid-primary" disabled={!valid || saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            {!valid && <span className="field-hint">Name, what it&apos;s about, where, and an owner.</span>}
          </div>
        </form>
      </div>
    </Container>
  );
};

export default EditClubAdmin;
