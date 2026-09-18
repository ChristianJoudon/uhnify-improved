import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import test from 'node:test';

/**
 * Two things that went wrong once, quietly, and must not again.
 *
 * An editing tool turned escape sequences written in source - a zero-width
 * space in a regular expression, a C1 control in a test - into the literal
 * characters. They are invisible in every editor and every diff; the code
 * still compiled, and meant something else. And a decoder that was right on
 * one machine was wrong on CI, because what a runtime does with a text
 * encoding's label, or with "lower-case this", depends on how that runtime
 * was built and which locale it woke up in.
 *
 * This file names its characters by number, on purpose: it has to survive
 * the same tools it guards against.
 */
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const SCANNED = ['services/community-ingestion/src', 'services/community-ingestion/test', 'services/community-ingestion/ADDING-SOURCES.md',
  'app/imports', 'app/server', 'app/client', 'app/private', 'config', 'doc', 'tools', '.github/workflows'];
const TEXT_FILE = /\.(?:ts|mts|js|jsx|mjs|json|md|css|yml|yaml|html)$/;
// Captured web pages are evidence, kept as they were served; everything we write ourselves is checked.
const CAPTURED = /test\/sites\/[^/]+\/pages\.json$|\/fixtures\//;

/** Code points nobody can see: C0 controls (but tab, LF, CR), DEL and C1, zero-width and joiners, BOM, bidi overrides, the replacement character. */
const INVISIBLE: Array<[number, number]> = [
  [0x00, 0x08], [0x0B, 0x0C], [0x0E, 0x1F], [0x7F, 0x9F], [0x200B, 0x200D], [0x2060, 0x2060],
  [0x202A, 0x202E], [0x2066, 0x2069], [0xFEFF, 0xFEFF], [0xFFFD, 0xFFFD],
];

const firstInvisible = (line: string): number | undefined => {
  for (const character of line) {
    const code = character.codePointAt(0)!;
    if (INVISIBLE.some(([from, to]) => code >= from && code <= to)) return code;
  }
  return undefined;
};

const filesUnder = (path: string): string[] => {
  let stats;
  try { stats = statSync(path); } catch { return []; }
  if (stats.isFile()) return TEXT_FILE.test(path) ? [path] : [];
  return readdirSync(path).filter(name => name !== 'node_modules' && !name.startsWith('.meteor'))
    .flatMap(name => filesUnder(join(path, name)));
};

test('no file we write carries a character nobody can see', () => {
  const found = SCANNED.flatMap(path => filesUnder(join(repo, path)))
    .filter(file => !CAPTURED.test(file))
    .flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
      const code = firstInvisible(line);
      return code === undefined ? [] : [`${relative(repo, file)}:${index + 1} U+${code.toString(16).toUpperCase().padStart(4, '0')}`];
    }));
  assert.deepEqual(found, [], 'an invisible character belongs in source as a backslash-u escape, never as itself');
});

test('how the worker reads text does not depend on how its runtime was built', () => {
  const offences = filesUnder(join(repo, 'services/community-ingestion/src')).flatMap(file => {
    const text = readFileSync(file, 'utf8');
    const name = relative(repo, file);
    return [
      // A legacy code page decoded by its label is plain Latin-1 on a Node without full ICU.
      ...(/text-repair\.ts$/.test(file) ? [] : [...text.matchAll(/new TextDecoder\(\s*['"](?!utf-?8)[^'"]+['"]/gi)].map(match => `${name}: ${match[0]} - use decodeBytes()`)),
      // Case-folding by the host's locale: "I" becomes a dotless i on a Turkish machine.
      ...[...text.matchAll(/\.toLocale(?:Lower|Upper)Case\(/g)].map(match => `${name}: ${match[0]}) - use toLowerCase() / toUpperCase()`),
    ];
  });
  assert.deepEqual(offences, []);
});
