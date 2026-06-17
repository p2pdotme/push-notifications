import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPool } from './helpers/test-db.js';

describe('schema', () => {
  it('creates every admin-plane and core table', async () => {
    const pool = await createTestPool();
    for (const t of ['subscriptions', 'notification_logs', 'apps', 'api_keys', 'cors_origins', 'admins']) {
      // A SELECT that returns no rows still throws if the table is missing.
      await assert.doesNotReject(pool.query(`SELECT 1 FROM ${t} LIMIT 0`), `table ${t} should exist`);
    }
    await pool.end();
  });
});
