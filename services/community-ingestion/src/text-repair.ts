/**
 * Getting a page's bytes into honest text.
 *
 * Two things go wrong before a parser ever sees a word. A small site built
 * years ago serves Windows-1252 and says so nowhere, and a strict UTF-8
 * decode throws — which used to end the whole run. And a site that was
 * migrated between hosts serves text that was decoded once too often: a
 * u-with-macron arrives as "A-ring, guillemet", an apostrophe as three
 * characters of noise. Both are recoverable, and neither should be left to
 * look like the publisher's own spelling on a card.
 *
 * Every unusual character in this file is written as an escape, so that no
 * editor, terminal or formatter can quietly "repair" the repairer.
 */
const declaredCharset = (contentType: string | undefined, head: string): string | undefined => {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  return (fromHeader ?? fromMeta)?.toLowerCase();
};

const tryDecode = (bytes: Uint8Array, label: string, fatal: boolean): string | undefined => {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** Windows-1252's printable characters in the 0x80–0x9F range: code point → byte. */
const CP1252: Record<number, number> = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
  0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
  0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
  0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
};

const byteOf = (code: number): number | undefined => (code <= 0xFF ? code : CP1252[code]);

const CP1252_BYTE_TO_CODE = new Map(Object.entries(CP1252).map(([code, byte]) => [byte, Number(code)]));

/**
 * Windows-1252, decoded here rather than by the runtime: a Node built
 * without full ICU answers to the label "windows-1252" with plain Latin-1,
 * and hands back curly quotes and dashes as invisible control characters.
 * (Browsers read "iso-8859-1" as Windows-1252 too, which is what pages that
 * declare it were tested against.)
 */
const decodeCp1252 = (bytes: Uint8Array): string => {
  let text = '';
  for (let index = 0; index < bytes.length; index += 8_192) {
    text += String.fromCharCode(...Array.from(bytes.subarray(index, index + 8_192), byte => CP1252_BYTE_TO_CODE.get(byte) ?? byte));
  }
  return text;
};

/**
 * Bytes to text: UTF-8 when the bytes are UTF-8; otherwise what the page
 * declares; otherwise Windows-1252, which is what an undeclared legacy page
 * almost always is. Never throws.
 */
export const decodeBytes = (bytes: Uint8Array, contentType?: string): string => {
  const strict = tryDecode(bytes, 'utf-8', true);
  if (strict !== undefined) return strict;
  const declared = declaredCharset(contentType, decodeCp1252(bytes.subarray(0, 2_048)));
  if (declared && !/^(?:utf-?8|windows-1252|cp1252|iso-8859-1|latin-?1|us-ascii|ascii)$/.test(declared)) {
    const asDeclared = tryDecode(bytes, declared, false);
    if (asDeclared !== undefined) return asDeclared;
  }
  return decodeCp1252(bytes);
};

/**
 * The tell-tale of UTF-8 read as Windows-1252: a lead byte (0xC2–0xF4, which
 * shows as an accented capital or "a-circumflex") followed by what was a
 * continuation byte (0x80–0xBF, which shows as a symbol or a C1 character).
 */
const looksBroken = (token: string): boolean => {
  for (let index = 0; index < token.length - 1; index += 1) {
    const lead = token.charCodeAt(index);
    const next = byteOf(token.charCodeAt(index + 1));
    if (lead >= 0xC2 && lead <= 0xF4 && next !== undefined && next >= 0x80 && next <= 0xBF) return true;
  }
  return false;
};

/**
 * Undo one round of UTF-8-read-as-Windows-1252, a word at a time, and only
 * where that is what happened: the word must carry the tell-tale pair, every
 * character in it must be one that a single byte could have produced, and
 * turning it back must give valid UTF-8. A page is often damaged in places
 * and fine in others (a migrated article beside a new one), so nothing is
 * decided for the page as a whole, and text that is merely unusual — "café",
 * typed correctly — is left exactly as it was: its e-acute is not followed
 * by a continuation byte, and would not decode if it were tried.
 */
// Words are split on ASCII white space only: a mangled non-breaking space is part of the damage.
export const repairMojibake = (text: string): string => text.replace(/[^ \t\r\n<>"]+/g, token => {
  if (!looksBroken(token)) return token;
  const bytes = new Uint8Array(token.length);
  for (let index = 0; index < token.length; index += 1) {
    const byte = byteOf(token.charCodeAt(index));
    if (byte === undefined) return token;
    bytes[index] = byte;
  }
  return tryDecode(bytes, 'utf-8', true) ?? token;
});
