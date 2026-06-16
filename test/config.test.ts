import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseList } from '../src/config.js';

describe('parseList', () => {
  it('splits, trims, and drops empties', () => {
    assert.deepEqual(parseList('a, b ,,c'), ['a', 'b', 'c']);
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(parseList(''), []);
    assert.deepEqual(parseList('   '), []);
  });
});
