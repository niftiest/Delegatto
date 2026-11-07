import Database from 'better-sqlite3'
import { DDL, SCHEMA_VERSION, MIGRATIONS } from './schema'

export type Catalog = Database.Database

function writeSchemaVersion(db: Catalog, version: number): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', String(version))
}

// Selects and sorts applicable migrations by toVersion ascending, ensuring
// they apply in version order regardless of declaration order in MIGRATIONS.
// This is a safety for future changes: if someone appends a migration out of
// order, it will still apply in the correct sequence.
export function selectMigrations(migrations: typeof MIGRATIONS, fromVersion: number): typeof MIGRATIONS {
  return migrations
    .filter(m => m.toVersion > fromVersion)
    .slice()
    .sort((a, b) => a.toVersion - b.toVersion)
}

// Runs every migration step newer than `fromVersion`, sorted by toVersion
// ascending, wrapping each step in its own transaction. A DB opened at any
// past (or absent) version catches up through every intervening step --
// additively, without dropping or altering whatever an older version already
// wrote. If any step fails partway, its DDL is rolled back atomically and
// the version remains unstamped, so a retry can proceed cleanly.
function runMigrations(db: Catalog, fromVersion: number): void {
  const steps = selectMigrations(MIGRATIONS, fromVersion)
  for (const step of steps) {
    db.transaction(() => step.apply(db))()
  }
}

export function openCatalog(filePath: string): Catalog {
  const db = new Database(filePath)
  db.exec(DDL)

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
  const stored = row === undefined ? null : Number(row.value)

  if (stored === null) {
    // Fresh DB: no prior version to migrate from, but it still needs every
    // table introduced by a MIGRATIONS step (the base DDL above only ever
    // covers the original v1 schema) -- run the full chain from 0.
    runMigrations(db, 0)
    writeSchemaVersion(db, SCHEMA_VERSION)
  } else if (stored === SCHEMA_VERSION) {
    // Already current: nothing to do.
  } else if (stored < SCHEMA_VERSION) {
    // A DB written by an older app build: run the additive steps it missed,
    // then stamp it current.
    runMigrations(db, stored)
    writeSchemaVersion(db, SCHEMA_VERSION)
  } else {
    // stored > SCHEMA_VERSION: this DB was written by a newer version of the
    // app. Proceeding as if the schema matched could silently corrupt data
    // the newer app relies on, so refuse instead of guessing. Close the
    // handle before throwing so the file isn't left locked open.
    db.close()
    throw new Error(
      `Catalog schema_version ${stored} is newer than this app's ${SCHEMA_VERSION}; refusing to open ` +
      `(the DB was likely created by a newer version of the app).`
    )
  }

  return db
}

export function closeCatalog(db: Catalog): void {
  db.close()
}
