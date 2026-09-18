import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBytes, repairMojibake } from '../src/text-repair.js';

// "Kūhiō" and "Līhuʻe" and "We’re" after a round of UTF-8-read-as-Windows-1252,
// kept as constants so the damage is in one place.
const KUHIO_BROKEN = 'KÅ«hiÅ\u008D';
const LIHUE_BROKEN = 'LÄ«huÊ»e';
const WERE_BROKEN = 'Weâ€™re';

test('a page that is not UTF-8 is read, not refused', () => {
  // Café “Luau” – 6pm, in Windows-1252
  const cp1252 = new Uint8Array([0x43, 0x61, 0x66, 0xE9, 0x20, 0x93, 0x4C, 0x75, 0x61, 0x75, 0x94, 0x20, 0x96, 0x20, 0x36, 0x70, 0x6D]);
  assert.equal(decodeBytes(cp1252), 'Café “Luau” – 6pm');
  assert.equal(decodeBytes(new TextEncoder().encode('Līhuʻe — 6 pm')), 'Līhuʻe — 6 pm', 'UTF-8 stays UTF-8');
  // <meta charset=iso-8859-1> followed by 0xE9
  const latin1 = new Uint8Array([...new TextEncoder().encode('<meta charset=iso-8859-1>'), 0xE9]);
  assert.match(decodeBytes(latin1), /é$/, 'the page’s own declaration is believed');
});

test('text decoded once too often is put back, a word at a time, and honest text is left alone', () => {
  assert.equal(repairMojibake(`${KUHIO_BROKEN} Highway at ${LIHUE_BROKEN} — ${WERE_BROKEN} open`),
    'Kūhiō Highway at Līhuʻe — We’re open');
  assert.equal(repairMojibake('HulaÂ Show tonight, HulaÂ Show tomorrow'), 'Hula Show tonight, Hula Show tomorrow');
  const honest = 'Café Portofino, Līhuʻe — “Pau Hana”';
  assert.equal(repairMojibake(honest), honest);
  assert.equal(repairMojibake(`A mixed page: ${KUHIO_BROKEN} beside Kūhiō`), 'A mixed page: Kūhiō beside Kūhiō');
});
