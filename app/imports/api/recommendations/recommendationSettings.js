import { Meteor } from 'meteor/meteor';

/**
 * The two switches an operator can throw without a deploy.
 *
 * Recommendations ship on day one, which means the first time they meet real
 * traffic is also the first day anyone is watching. There was no way to turn
 * them off short of reverting the release: `Meteor.settings.recommendations`
 * was read for weights and a model name and nothing else.
 *
 * Both are read at CALL time, never captured when the module loads. A value
 * captured at load cannot be flipped by a test, and — the case that matters —
 * leaves nobody able to say, from reading the settings file a running process
 * was started with, what that process is actually doing.
 *
 * Absent means on. A settings file written before these existed must go on
 * behaving exactly as it did, and an operator who mistypes the key must not
 * discover on launch day that recommendations were never running.
 */
const configured = () => Meteor.settings?.recommendations || {};

/** False sends 'recommendations.get' down the baseline path for everyone. */
export const recommendationsEnabled = () => configured().enabled !== false;

/**
 * False stops the behaviour log: no interactions, impressions, item states,
 * graph edges or request rows are written. A person's RSVPs are still kept —
 * see interactionRecorder.js for why those are not telemetry.
 */
export const interactionRecordingEnabled = () => configured().recordInteractions !== false;
