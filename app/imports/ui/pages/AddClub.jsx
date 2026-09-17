import React, { useMemo, useRef, useState } from 'react';
import { Container, Form } from 'react-bootstrap';
import swal from 'sweetalert';
import { Meteor } from 'meteor/meteor';
import { useNavigate } from 'react-router-dom';
import { Camera, Trash } from 'react-bootstrap-icons';
import PosterArt from '../components/PosterArt';
import PrivacyToggles from '../components/PrivacyToggles';
import ChipInput from '../components/form/ChipInput';
import SchedulePicker from '../components/form/SchedulePicker';
import { weekUnknown } from '../components/form/SchedulePickerModel';
import { scheduleLabel } from '../../api/club/schedule';
import { TEXT_LIMITS } from '../../api/listing/limits';
import { isSensitiveListing } from '../../api/privacy/FriendActivityPrivacy';
import { shrinkImage } from '../utilities/shrinkImage';
import { TOPICS, TOPIC_KEYS, topicFor } from '../utilities/topics';

/** The category a chosen topic is stored as — see the insert below. */
const categoryOf = topicKey => (topicKey ? (TOPICS[topicKey].category || TOPICS[topicKey].label) : '');

const AddClub = () => {
  const navigate = useNavigate();
  const fileInput = useRef(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    location: '',
    contactInfo: '',
    topicKey: '',
    tags: [],
    image: '',
    schedule: { days: [], time: '17:00', cadence: 'weekly' },
    // Open, named and unasked: what every group was before it could be
    // anything else, and still the right start for a hiking crew.
    privacy: { visibility: 'public', anonymous: false, approveMembers: false },
  });

  const set = (field, value) => setForm(current => ({ ...current, [field]: value }));
  const setPrivacy = patch => setForm(current => ({ ...current, privacy: { ...current.privacy, ...patch } }));

  // The server's own test, run on what the form holds so far. A group filed
  // under support, health, LGBTQ+ or faith is anonymous whatever its owner
  // ticks, and the switch says so while the form is still open — finding out
  // afterwards, from a member list that never appears, is finding out too late
  // to have chosen a different word for the tag.
  const anonymousLocked = useMemo(
    () => isSensitiveListing({ categories: categoryOf(form.topicKey), tags: form.tags }),
    [form.topicKey, form.tags],
  );

  // Until a topic is picked, the preview shows what the club would be filed as
  // from its own words — the same resolution the finder will apply.
  // Resolve exactly the way the saved card will, from the same sources in the
  // same order, so the preview's colour is the colour that gets stored.
  const topic = useMemo(
    () => topicFor(form.topicKey ? TOPICS[form.topicKey].label : '', form.tags, form.name, form.description),
    [form.topicKey, form.tags, form.name, form.description],
  );

  const when = scheduleLabel(form.schedule);
  // "Once a month" with every week unpicked is a group that would be labelled
  // "Monthly" and put on no calendar at all. The edit page has to let that
  // stand, because listings arrive that way; nothing new should start there.
  const valid = form.name.trim() && form.description.trim() && form.location.trim()
    && form.schedule.days.length > 0 && !weekUnknown(form.schedule);

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
    Meteor.call('Clubs.insert', {
      name: form.name.trim(),
      description: form.description.trim(),
      location: form.location.trim(),
      // Empty string, never undefined: check() rejects a present-but-undefined
      // key, which throws in the client stub and kills latency compensation.
      image: form.image,
      // The stored text stays human-readable; the structured schedule is what
      // the calendars actually expand.
      meetingTime: when || 'Schedule to come',
      contactInfo: form.contactInfo.trim(),
      // Only an explicitly chosen topic becomes the category; the fallback
      // label is a display word, not a subject.
      categories: categoryOf(form.topicKey),
      tags: form.tags,
      schedule: form.schedule,
      // Sent as the switches stood. The server has the last word on two of
      // them — a sensitive group is anonymous, and an anonymous group cannot
      // ask first — and the manage page this leads to shows what it decided.
      visibility: form.privacy.visibility,
      anonymous: form.privacy.anonymous,
      approveMembers: form.privacy.approveMembers,
    }, (error, clubId) => {
      setSaving(false);
      if (error) {
        swal('Could not create', error.reason || error.message, 'error');
        return;
      }
      // To the group's own page, not to Nearby. A private group is not ON
      // Nearby — its invite link is the only way in, and this is the page
      // that has it. Sending its founder off to search for it was sending
      // them to look for something they could never find.
      const isPrivate = form.privacy.visibility === 'private';
      swal(
        'Created',
        isPrivate ? `${form.name.trim()} is ready. Its invite link is next.` : `${form.name.trim()} is live.`,
        'success',
      ).then(() => navigate(clubId ? `/manage/group/${clubId}` : '/saved'));
    });
  };

  return (
    <Container id="add-clubs" className="page-shell py-4">
      <div className="page-intro">
        <h1>Start a group</h1>
        <p>People will find this by topic, distance, and when it meets.</p>
      </div>

      <div className="create-layout">
        <aside className="create-preview">
          <span className="create-preview-label">Preview</span>
          <div className="mb-poster mb-poster-lg">
            <PosterArt
              topic={topic}
              eyebrow={when}
              title={form.name}
              tagline={form.description}
              image={form.image}
              placeholder="Your group name"
            />
            <div className="mb-poster-foot">
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
                placeholder="Sunrise Hiking Crew"
                onChange={e => set('name', e.target.value)}
                required
              />
            </label>

            <label htmlFor="description">
              What it&apos;s about
              <textarea
                id="description"
                rows={3}
                value={form.description}
                maxLength={TEXT_LIMITS.description}
                placeholder="Who it's for and what you actually do."
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
                placeholder="Līhuʻe Neighborhood Center"
                onChange={e => set('location', e.target.value)}
                required
              />
            </label>
          </section>

          <section className="form-block">
            <h3>When you meet</h3>
            <SchedulePicker value={form.schedule} onChange={value => set('schedule', value)} />
          </section>

          <section className="form-block">
            <h3>Topic</h3>
            <p className="form-note">Sets the poster and decides who gets shown this.</p>
            <div className="topic-picker">
              {TOPIC_KEYS.map(key => {
                const option = TOPICS[key];
                const on = form.topicKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`topic-pick${on ? ' is-on' : ''}`}
                    aria-pressed={on}
                    style={on ? { background: option.chip, borderColor: option.chipInk, color: option.chipInk } : undefined}
                    onClick={() => set('topicKey', on ? '' : key)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            <div className="mt-3">
              <label className="field-label" htmlFor="tags">Tags</label>
              <ChipInput
                id="tags"
                values={form.tags}
                onChange={value => set('tags', value)}
                placeholder="board games, beginners welcome…"
                hint="Press Enter after each. These help people find you."
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
              <Form.Control ref={fileInput} type="file" accept="image/*" onChange={pickImage} className="d-none" />
            </div>
            <span className="field-hint">Optional — without one we design a poster from your topic.</span>
          </section>

          <section className="form-block">
            <h3>Contact</h3>
            <label htmlFor="contactInfo">
              How to reach your group
              <input
                id="contactInfo"
                type="text"
                value={form.contactInfo}
                maxLength={TEXT_LIMITS.contactInfo}
                placeholder="hello@yourgroup.org"
                onChange={e => set('contactInfo', e.target.value)}
                aria-describedby="contactInfo-hint"
              />
            </label>
            <span className="field-hint" id="contactInfo-hint">
              Optional — printed on the group&apos;s card for anyone to see.
            </span>
          </section>

          {/* Last, and a card of its own: everything above describes the
              group, and this decides who gets to read that description. All of
              it can be changed afterwards from the group's page. */}
          <section className="form-block" aria-labelledby="add-club-privacy">
            <h3 id="add-club-privacy">Privacy</h3>
            <PrivacyToggles
              kind="club"
              idPrefix="add-club"
              value={form.privacy}
              anonymousLocked={anonymousLocked}
              onChange={setPrivacy}
            />
          </section>

          <div className="create-actions">
            <button id="submit" type="submit" className="btn btn-solid-primary" disabled={!valid || saving}>
              {saving ? 'Creating…' : 'Create group'}
            </button>
            {!valid && <span className="field-hint">Name, what it&apos;s about, where, at least one day — and which week, if it&apos;s monthly.</span>}
          </div>
        </form>
      </div>
    </Container>
  );
};

export default AddClub;
