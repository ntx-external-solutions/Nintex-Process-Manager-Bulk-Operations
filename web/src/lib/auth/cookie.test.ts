import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCookie } from './cookie.ts';

test('reads a single cookie', () => {
  assert.equal(readCookie('npmbo_session=abc', 'npmbo_session'), 'abc');
});

test('picks the right cookie out of several', () => {
  assert.equal(readCookie('a=1; npmbo_session=abc; b=2', 'npmbo_session'), 'abc');
});

test('does not match a cookie whose name merely ends with the target', () => {
  // "other_npmbo_session" must not be mistaken for "npmbo_session".
  assert.equal(readCookie('other_npmbo_session=wrong', 'npmbo_session'), null);
});

test('tolerates surrounding whitespace', () => {
  assert.equal(readCookie('  npmbo_session =  abc  ', 'npmbo_session'), 'abc');
});

test('handles values containing an equals sign', () => {
  // Base64url avoids padding, but the parser should not split on every "=".
  assert.equal(readCookie('npmbo_session=a=b=c', 'npmbo_session'), 'a=b=c');
});

test('percent-decodes the value', () => {
  assert.equal(readCookie('npmbo_session=a%20b', 'npmbo_session'), 'a b');
});

test('a malformed escape yields the raw value rather than throwing', () => {
  assert.equal(readCookie('npmbo_session=%E0%A4%A', 'npmbo_session'), '%E0%A4%A');
});

test('missing header or cookie is null', () => {
  assert.equal(readCookie(null, 'npmbo_session'), null);
  assert.equal(readCookie(undefined, 'npmbo_session'), null);
  assert.equal(readCookie('', 'npmbo_session'), null);
  assert.equal(readCookie('a=1; b=2', 'npmbo_session'), null);
});

test('an empty value reads as empty, which unseals to "not signed in"', () => {
  assert.equal(readCookie('npmbo_session=', 'npmbo_session'), '');
});
