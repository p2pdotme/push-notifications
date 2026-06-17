import { newDb } from 'pg-mem';
import { MIGRATION_SQL } from '../../src/db.js';

/**
 * An in-memory Postgres-compatible Pool for tests. Runs the exact production
 * migration SQL so tests exercise the real schema without Docker. Swap the
 * body for a real `pg.Pool` against TEST_DATABASE_URL to run against true
 * Postgres in CI.
 */
export async function createTestPool() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await pool.query(MIGRATION_SQL);
  return pool as unknown as import('pg').Pool;
}
