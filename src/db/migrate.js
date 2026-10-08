import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const advisoryLockKey = 7_309_472_201;

function migrationVersion(fileName) {
  const match = /^(\d+)_.*\.sql$/.exec(fileName);
  if (!match) throw new Error(`Invalid migration filename: ${fileName}`);
  return Number.parseInt(match[1], 10);
}

async function loadMigrations() {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => migrationVersion(left) - migrationVersion(right));
  const versions = new Set();

  return Promise.all(names.map(async (name) => {
    const version = migrationVersion(name);
    if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
    versions.add(version);
    const sql = await readFile(resolve(migrationsDirectory, name), 'utf8');
    if (/\b(?:DROP|TRUNCATE)\b/i.test(sql.replace(/--.*$/gm, ''))) {
      throw new Error(`Destructive statement rejected in migration: ${name}`);
    }
    return {
      version,
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  }));
}

export async function runMigrations() {
  const migrations = await loadMigrations();
  const client = await pool.connect();
  let appliedCount = 0;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockKey]);
    const tableExists = (await client.query("SELECT to_regclass('public.schema_migrations') AS name")).rows[0].name;
    const applied = tableExists
      ? await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      : { rows: [] };
    const appliedByVersion = new Map(applied.rows.map((row) => [Number(row.version), row]));

    for (const migration of migrations) {
      const previous = appliedByVersion.get(migration.version);
      if (previous) {
        if (previous.name !== migration.name || previous.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch: ${migration.name}`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]).catch(() => {});
    client.release();
  }

  return appliedCount;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const appliedCount = await runMigrations();
    console.log(`Applied ${appliedCount} migration${appliedCount === 1 ? '' : 's'}.`);
  } finally {
    await pool.end();
  }
}
