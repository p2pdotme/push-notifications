import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';

describe('openDatabase pragmas', () => {
  it('applies low-memory pragmas', () => {
    const db = openDatabase(':memory:');
    // negative cache_size = KiB of memory; we set a small bounded cache.
    assert.ok((db.pragma('cache_size', { simple: true }) as number) < 0);
    db.close();
  });

  it('sets mmap_size = 0 on a file database', () => {
    const dir = join(tmpdir(), `push-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'test.db');
    try {
      const db = openDatabase(dbPath);
      assert.equal(db.pragma('mmap_size', { simple: true }), 0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
