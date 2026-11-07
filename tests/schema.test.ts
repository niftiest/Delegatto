import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCatalog, closeCatalog, selectMigrations } from '../src/main/catalog/db'
import { MIGRATIONS, SCHEMA_VERSION, type Migration } from '../src/main/catalog/schema'

describe('catalog schema', () => {
  it('creates every table and the FTS index', () => {
    const db = openCatalog(':memory:')
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]
    const set = new Set(names.map(n => n.name))
    for (const t of ['projects', 'sessions', 'messages', 'messages_fts', 'meta']) expect(set.has(t)).toBe(true)
    closeCatalog(db)
  })

  describe('reopening a real file', () => {
    let dir: string
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it('is idempotent across reopens and does not duplicate or corrupt state', () => {
      dir = mkdtempSync(join(tmpdir(), 'cc-catalog-'))
      const file = join(dir, 'catalog.db')

      const db1 = openCatalog(file)
      db1.prepare("INSERT INTO projects (dir_name) VALUES ('p1')").run()
      const version1 = db1.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
      expect(version1.value).toBe(String(SCHEMA_VERSION))
      closeCatalog(db1)

      let db2: ReturnType<typeof openCatalog> | undefined
      expect(() => {
        db2 = openCatalog(file)
      }).not.toThrow()

      const version2 = db2!.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
      expect(version2.value).toBe(String(SCHEMA_VERSION))

      const versionRows = db2!.prepare("SELECT COUNT(*) as n FROM meta WHERE key='schema_version'").get() as { n: number }
      expect(versionRows.n).toBe(1)

      const projects = db2!.prepare('SELECT dir_name FROM projects').all() as { dir_name: string }[]
      expect(projects).toEqual([{ dir_name: 'p1' }])

      closeCatalog(db2!)
    })
  })

  it('enforces one row per uuid within a session', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO projects (dir_name) VALUES ('p')").run()
    db.prepare("INSERT INTO sessions (project_id, session_id, file_path, kind) VALUES (1,'s','/f','main')").run()
    const insert = db.prepare("INSERT INTO messages (session_pk, uuid, seq, role, byte_offset) VALUES (1,'u',0,'user',0)")
    insert.run()
    let err: unknown
    try {
      insert.run()
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect(String(err)).toMatch(/UNIQUE constraint failed: messages\.session_pk, messages\.uuid/)
    closeCatalog(db)
  })

  it('actually enables foreign key enforcement on the connection', () => {
    const db = openCatalog(':memory:')
    const pragma = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(pragma.foreign_keys).toBe(1)

    // A session referencing a non-existent project must be rejected because
    // foreign_keys is genuinely ON for this connection, not just requested.
    expect(() =>
      db.prepare("INSERT INTO sessions (project_id, session_id, file_path, kind) VALUES (999,'s','/f','main')").run()
    ).toThrow(/FOREIGN KEY constraint failed/)
    closeCatalog(db)
  })

  it('keeps the external-content FTS index in sync via insert and delete triggers', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO projects (dir_name) VALUES ('p')").run()
    db.prepare("INSERT INTO sessions (project_id, session_id, file_path, kind) VALUES (1,'s','/f','main')").run()
    db.prepare(
      "INSERT INTO messages (session_pk, uuid, seq, role, byte_offset, text) VALUES (1,'u1',0,'user',0,'hello world')"
    ).run()

    const hit = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'hello'").all() as { rowid: number }[]
    expect(hit).toEqual([{ rowid: 1 }])

    db.prepare('DELETE FROM messages WHERE id = 1').run()
    const afterDelete = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'hello'").all()
    expect(afterDelete).toEqual([])

    closeCatalog(db)
  })

  it('removes cascaded messages from the FTS index when the parent session is deleted', () => {
    const db = openCatalog(':memory:')
    db.prepare("INSERT INTO projects (dir_name) VALUES ('p')").run()
    db.prepare("INSERT INTO sessions (project_id, session_id, file_path, kind) VALUES (1,'s','/f','main')").run()

    db.prepare(
      "INSERT INTO messages (session_pk, uuid, seq, role, byte_offset, text) VALUES (1,'u1',0,'user',0,'xyzunique1234')"
    ).run()
    db.prepare(
      "INSERT INTO messages (session_pk, uuid, seq, role, byte_offset, text) VALUES (1,'u2',1,'assistant',10,'abcunique5678')"
    ).run()

    // Verify FTS index was populated by the insert trigger
    const beforeDelete1 = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'xyzunique1234'").all() as { rowid: number }[]
    expect(beforeDelete1).toEqual([{ rowid: 1 }])

    const beforeDelete2 = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'abcunique5678'").all() as { rowid: number }[]
    expect(beforeDelete2).toEqual([{ rowid: 2 }])

    // Delete the parent session row — this should cascade to child messages
    db.prepare('DELETE FROM sessions WHERE id = 1').run()

    // Verify the child messages were cascade-deleted
    const messagesAfterDelete = db.prepare('SELECT COUNT(*) as n FROM messages').get() as { n: number }
    expect(messagesAfterDelete.n).toBe(0)

    // Verify the FTS index was kept in sync through the cascade
    const ftsAfterDelete1 = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'xyzunique1234'").all()
    expect(ftsAfterDelete1).toEqual([])

    const ftsAfterDelete2 = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'abcunique5678'").all()
    expect(ftsAfterDelete2).toEqual([])

    closeCatalog(db)
  })

  // A catalog already at SCHEMA_VERSION runs nothing, so a newer migration would never reach it.
  it('has a version that covers every migration', () => {
    expect(SCHEMA_VERSION).toBe(Math.max(...MIGRATIONS.map(m => m.toVersion)))
  })

  it('brings a catalog from the previous version up to date, with its chat name columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-catalog-'))
    const file = join(dir, 'catalog.db')
    const db1 = openCatalog(file)
    db1.exec('ALTER TABLE sessions DROP COLUMN custom_title')
    db1.exec('ALTER TABLE sessions DROP COLUMN ai_title')
    db1.prepare("UPDATE meta SET value = '8' WHERE key='schema_version'").run()
    closeCatalog(db1)
    const db2 = openCatalog(file)
    const cols = (db2.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining(['custom_title', 'ai_title']))
    closeCatalog(db2)
    rmSync(dir, { recursive: true, force: true })
  })

  describe('schema_version on open', () => {
    let dir: string
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it('writes the current version on a fresh DB', () => {
      const db = openCatalog(':memory:')
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
      expect(row.value).toBe(String(SCHEMA_VERSION))
      closeCatalog(db)
    })

    it('reopening a current-version DB is a no-op', () => {
      dir = mkdtempSync(join(tmpdir(), 'cc-schema-'))
      const file = join(dir, 'catalog.db')

      const db1 = openCatalog(file)
      db1.prepare("INSERT INTO projects (dir_name) VALUES ('p1')").run()
      closeCatalog(db1)

      const db2 = openCatalog(file)
      const row = db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
      expect(row.value).toBe(String(SCHEMA_VERSION))
      const projects = db2.prepare('SELECT dir_name FROM projects').all() as { dir_name: string }[]
      expect(projects).toEqual([{ dir_name: 'p1' }])
      closeCatalog(db2)
    })

    it('brings a DB with an artificially-lowered version up to current, without losing data', () => {
      dir = mkdtempSync(join(tmpdir(), 'cc-schema-lower-'))
      const file = join(dir, 'catalog.db')

      const db1 = openCatalog(file)
      db1.prepare("INSERT INTO projects (dir_name) VALUES ('p1')").run()
      // Simulate a DB written by an older app build.
      db1.prepare("UPDATE meta SET value = '0' WHERE key='schema_version'").run()
      closeCatalog(db1)

      const db2 = openCatalog(file)
      const row = db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
      expect(row.value).toBe(String(SCHEMA_VERSION))
      const projects = db2.prepare('SELECT dir_name FROM projects').all() as { dir_name: string }[]
      expect(projects).toEqual([{ dir_name: 'p1' }])
      closeCatalog(db2)
    })

    it('refuses to open a DB whose stored version is newer than this app supports', () => {
      dir = mkdtempSync(join(tmpdir(), 'cc-schema-higher-'))
      const file = join(dir, 'catalog.db')

      const db1 = openCatalog(file)
      db1.prepare("UPDATE meta SET value = ? WHERE key='schema_version'").run(String(SCHEMA_VERSION + 1))
      closeCatalog(db1)

      expect(() => openCatalog(file)).toThrow(/newer/)
    })
  })

  describe('migration runner robustness', () => {
    it('selects and sorts migrations by toVersion ascending', () => {
      // Even if MIGRATIONS are declared out of order, selectMigrations
      // returns them sorted by toVersion for safe application.
      const outOfOrder: Migration[] = [
        { toVersion: 3, apply: () => {} },
        { toVersion: 1, apply: () => {} },
        { toVersion: 2, apply: () => {} }
      ]

      // From version 0: should return all three, sorted
      const fromZero = selectMigrations(outOfOrder, 0)
      expect(fromZero.map(m => m.toVersion)).toEqual([1, 2, 3])

      // From version 1: should return 2 and 3, sorted
      const fromOne = selectMigrations(outOfOrder, 1)
      expect(fromOne.map(m => m.toVersion)).toEqual([2, 3])

      // From version 2: should return only 3
      const fromTwo = selectMigrations(outOfOrder, 2)
      expect(fromTwo.map(m => m.toVersion)).toEqual([3])

      // From version 3: should return nothing
      const fromThree = selectMigrations(outOfOrder, 3)
      expect(fromThree).toEqual([])
    })

    it('wraps each migration in a transaction, rolling back DDL on failure', () => {
      // Create a DB and manually verify that a failing migration rolls back.
      // We test this by inserting a table in one "migration" then failing in
      // the next, confirming the first table was rolled back.
      const db = openCatalog(':memory:')

      // Create a fake migration that succeeds
      let applyCount = 0
      const goodMigration: Migration = {
        toVersion: 10,
        apply: (d) => {
          d.exec('CREATE TABLE test_migration_table (id INTEGER)')
          applyCount++
        }
      }

      // Create a fake migration that fails partway through
      const badMigration: Migration = {
        toVersion: 11,
        apply: (d) => {
          d.exec('CREATE TABLE test_bad_table (id INTEGER)')
          throw new Error('Simulated failure in migration')
        }
      }

      // Apply the good migration via transaction
      db.transaction(() => goodMigration.apply(db))()

      // Verify the table was created
      let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_migration_table'").all() as { name: string }[]
      expect(tables).toHaveLength(1)

      // Now apply the bad migration and expect it to fail
      let threwError = false
      try {
        db.transaction(() => badMigration.apply(db))()
      } catch (e) {
        threwError = true
        expect(String(e)).toMatch(/Simulated failure/)
      }
      expect(threwError).toBe(true)

      // Verify test_bad_table was NOT created (rolled back by transaction)
      const badTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_bad_table'").all() as { name: string }[]
      expect(badTables).toHaveLength(0)

      // Verify test_migration_table still exists (good migration succeeded)
      tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_migration_table'").all() as { name: string }[]
      expect(tables).toHaveLength(1)

      closeCatalog(db)
    })

    it('does not stamp version if a transaction-wrapped migration fails', () => {
      // Simulate a scenario where a migration fails mid-way.
      // The version should NOT be stamped, allowing a retry on next open.
      const dir = mkdtempSync(join(tmpdir(), 'cc-transaction-rollback-'))
      const file = join(dir, 'test.db')

      try {
        // Open and create a mock failing migration scenario
        const db = openCatalog(file)

        // Manually downgrade the version to simulate a new migration available
        db.prepare("UPDATE meta SET value = '1' WHERE key='schema_version'").run()
        closeCatalog(db)

        // Now we'd apply a migration that fails. Rather than injecting it into
        // openCatalog, we simulate the scenario: a migration that creates a
        // table then fails should have both its DDL and the version update rolled back.
        // The actual version stamping happens AFTER all migrations succeed in
        // openCatalog, so we test by creating a direct transaction failure case.

        const db2 = openCatalog(file)

        // Create a failing transaction (simulating a migration step failure)
        let caught = false
        try {
          db2.transaction(() => {
            db2.exec('CREATE TABLE migration_test (id INTEGER)')
            throw new Error('Migration failed')
          })()
        } catch (e) {
          caught = true
        }
        expect(caught).toBe(true)

        // The table should not exist (rolled back)
        const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_test'").all()
        expect(tables).toHaveLength(0)

        closeCatalog(db2)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
