// Unit tests for web/commands.js — POST /api/cmd query construction
// and the user-facing `args` shorthand parser used by both the cmd
// strip and saved presets.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadModule } from './_load.mjs';

const win = loadModule('commands.js');
const { buildQuery, parseAdvArgs } = win.Conduit.cmd;

// ---- buildQuery -----------------------------------------------------

test('buildQuery: bare command name with no args', () => {
  assert.equal(buildQuery('led_on'), 'name=led_on');
  assert.equal(buildQuery('led_on', null), 'name=led_on');
  assert.equal(buildQuery('led_on', {}), 'name=led_on');
});

test('buildQuery: single key=value', () => {
  assert.equal(buildQuery('set_amp', { value: 1.5 }), 'name=set_amp&value=1.5');
});

test('buildQuery: multiple args', () => {
  // Object key order is insertion order
  const q = buildQuery('do', { a: 1, b: 'two', c: 3 });
  assert.equal(q, 'name=do&a=1&b=two&c=3');
});

test('buildQuery: skips null/undefined args (lets caller pass partials)', () => {
  const q = buildQuery('do', { a: 1, b: null, c: undefined, d: 0 });
  // Note: 0 stringifies to "0" and IS sent (intentional).
  assert.equal(q, 'name=do&a=1&d=0');
});

test('buildQuery: URL-encodes name and values', () => {
  // Spaces, ampersands, plus signs in the name must be encoded so the
  // device parses ?name=… correctly.
  const q = buildQuery('hello world', { msg: 'a&b=c d', extra: '+' });
  assert.equal(q, 'name=hello%20world&msg=a%26b%3Dc%20d&extra=%2B');
});

test('buildQuery: stringifies non-string values', () => {
  const q = buildQuery('cmd', { i: 42, f: 1.25, b: true });
  assert.equal(q, 'name=cmd&i=42&f=1.25&b=true');
});

// ---- parseAdvArgs ---------------------------------------------------

test('parseAdvArgs: empty / null / undefined → {}', () => {
  assert.deepEqual(parseAdvArgs(''),         {});
  assert.deepEqual(parseAdvArgs(null),       {});
  assert.deepEqual(parseAdvArgs(undefined),  {});
});

test('parseAdvArgs: bare numeric → { value: "..." } (the typed-cmd shortcut)', () => {
  assert.deepEqual(parseAdvArgs('0.1'),  { value: '0.1' });
  assert.deepEqual(parseAdvArgs('-5'),   { value: '-5' });
  assert.deepEqual(parseAdvArgs(' 12 '), { value: '12' });
});

test('parseAdvArgs: bare string (no separators) also → { value: ... }', () => {
  assert.deepEqual(parseAdvArgs('hello'), { value: 'hello' });
});

test('parseAdvArgs: comma-separated k=v', () => {
  assert.deepEqual(parseAdvArgs('a=1,b=2,c=3'), { a: '1', b: '2', c: '3' });
});

test('parseAdvArgs: ampersand-separated k=v also works', () => {
  assert.deepEqual(parseAdvArgs('a=1&b=2'), { a: '1', b: '2' });
});

test('parseAdvArgs: trims whitespace inside k=v', () => {
  assert.deepEqual(parseAdvArgs('  a = 1 , b= 2'), { a: '1', b: '2' });
});

test('parseAdvArgs: skips fragments without `=`', () => {
  assert.deepEqual(parseAdvArgs('a=1,nokey,b=2'), { a: '1', b: '2' });
});

test('parseAdvArgs: skips fragments where `=` is leading', () => {
  // "=1" has eq at index 0, which is not > 0 — silently dropped.
  assert.deepEqual(parseAdvArgs('=1,b=2'), { b: '2' });
});

test('parseAdvArgs: keeps `=` inside the value (only first one splits)', () => {
  assert.deepEqual(parseAdvArgs('expr=a=b'), { expr: 'a=b' });
});

// ---- Composition: parseAdvArgs → buildQuery -------------------------

test('composition: bare value flows through to ?name=cmd&value=0.1', () => {
  const q = buildQuery('set_amp', parseAdvArgs('0.1'));
  assert.equal(q, 'name=set_amp&value=0.1');
});

test('composition: multi-arg shorthand → url query', () => {
  const q = buildQuery('do', parseAdvArgs('a=1,b=hello world'));
  assert.equal(q, 'name=do&a=1&b=hello%20world');
});
