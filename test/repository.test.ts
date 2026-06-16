import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';

describe('schema', () => {
  it('creates the admin-plane tables', () => {
    const db = openDatabase(':memory:');
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of ['apps', 'api_keys', 'cors_origins', 'admins']) {
      assert.ok(names.includes(t), `expected table ${t}`);
    }
    db.close();
  });
});
