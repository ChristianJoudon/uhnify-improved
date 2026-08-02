/**
 * What a public listing actually carries.
 *
 * Every field is optional because the sources are uneven — a county calendar
 * may publish a street address and nothing else, a library may give a phone but
 * no cost, a venue may give neither. Rather than inventing defaults, the record
 * simply omits what was never published, and the card schema in
 * ui/utilities/cardFields.js drops any row whose value is absent.
 *
 * Shared by events and clubs so the two describe themselves the same way and
 * one schema can read either.
 */
export const listingFields = {
  region: { type: String, optional: true },
  /** { type: 'free'|'paid'|'unknown', amountMin, amountMax, raw } */
  cost: { type: Object, optional: true, blackbox: true },
  audience: { type: String, optional: true },
  registrationNote: { type: String, optional: true },
  phone: { type: String, optional: true },
  email: { type: String, optional: true },
  /** Provenance, kept so a record can be re-checked or claimed by its owner. */
  source: { type: Object, optional: true, blackbox: true },
};
