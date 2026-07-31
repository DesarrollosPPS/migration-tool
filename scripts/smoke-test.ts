import * as sql from "mssql";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMigrationFile,
  getStatus,
  loadConfigFromEnv,
  resolveMigrationsDir,
  runMigrations,
  toMssqlConfig,
} from "../src/index";

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS: ${message}`);
  } else {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}

async function ensureDatabase(pool: sql.ConnectionPool, database: string): Promise<void> {
  await pool.request().batch(`IF DB_ID(N'${database}') IS NULL CREATE DATABASE [${database}]`);
}

async function main(): Promise<void> {
  const config = loadConfigFromEnv();

  const masterPool = new sql.ConnectionPool(toMssqlConfig({ ...config, database: "master" }));
  await masterPool.connect();
  await ensureDatabase(masterPool, config.database);
  await masterPool.close();

  const pool = new sql.ConnectionPool(toMssqlConfig(config));
  await pool.connect();

  try {
    const reset = `
      IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NOT NULL DROP TABLE dbo.schema_migrations;
      IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL DROP TABLE dbo.users;
      IF OBJECT_ID(N'dbo.rollback_good', N'U') IS NOT NULL DROP TABLE dbo.rollback_good;
      IF OBJECT_ID(N'dbo.rollback_bad', N'U') IS NOT NULL DROP TABLE dbo.rollback_bad;
    `;
    await pool.request().batch(reset);

    const dir = resolveMigrationsDir();

    const statusBefore = await getStatus({ pool, migrationsDir: dir });
    assert(statusBefore.length === 2, "discovered both sample migrations");
    assert(statusBefore.every((s) => s.status === "pending"), "all migrations pending on a fresh database");

    const first = statusBefore[0].name;
    const targeted = await runMigrations({ pool, migrationsDir: dir, target: first });
    assert(targeted.applied.length === 1 && targeted.applied[0] === first, "--to applies only up to the target migration");
    await pool.request().batch(reset);

    const firstRun = await runMigrations({ pool, migrationsDir: dir });
    assert(firstRun.applied.length === 2, `first run applied both migrations (got ${firstRun.applied.length})`);
    assert(firstRun.skipped.length === 0, "no migrations skipped on first run");

    const users = await pool.request().query("SELECT COUNT(*) AS n FROM dbo.users");
    assert(users.recordset[0].n === 3, "seed data inserted 3 users (GO batches included)");

    const history = await pool.request().query("SELECT COUNT(*) AS n FROM dbo.schema_migrations");
    assert(history.recordset[0].n === 2, "history table records both migrations");

    const secondRun = await runMigrations({ pool, migrationsDir: dir });
    assert(secondRun.applied.length === 0 && secondRun.skipped.length === 2, "second run is a no-op (idempotent)");

    const statusAfter = await getStatus({ pool, migrationsDir: dir });
    assert(statusAfter.every((s) => s.status === "applied"), "status reports everything applied");
    assert(statusAfter.every((s) => s.appliedAt instanceof Date), "status reports applied_at timestamps");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "migration-tool-test-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, "20260731120000_good_migration.sql"),
        "CREATE TABLE dbo.rollback_good (id INT NOT NULL);",
      );
      await fs.writeFile(
        path.join(tmpDir, "20260731120001_bad_migration.sql"),
        "CREATE TABLE dbo.rollback_bad (id INT NOT NULL);\nTHIS IS NOT VALID SQL;",
      );

      let threw = false;
      try {
        await runMigrations({ pool, migrationsDir: tmpDir });
      } catch (err) {
        threw = true;
        console.log(`  (expected failure: ${err instanceof Error ? err.message : String(err)})`);
      }
      assert(threw, "a failing migration aborts the run");

      const badHistory = await pool.request().query(
        "SELECT COUNT(*) AS n FROM dbo.schema_migrations WHERE name = '20260731120001_bad_migration.sql'",
      );
      assert(badHistory.recordset[0].n === 0, "failed migration is not recorded in history");

      const badTable = await pool.request().query("SELECT COUNT(*) AS n FROM sys.tables WHERE name = 'rollback_bad'");
      assert(badTable.recordset[0].n === 0, "failed migration rolled back atomically");

      const goodTable = await pool.request().query("SELECT COUNT(*) AS n FROM sys.tables WHERE name = 'rollback_good'");
      assert(goodTable.recordset[0].n === 1, "migrations before the failure are kept");
    } finally {
      await pool.request().batch("IF OBJECT_ID(N'dbo.rollback_good', N'U') IS NOT NULL DROP TABLE dbo.rollback_good");
      await fs.rm(tmpDir, { recursive: true, force: true });
    }

    const created = await createMigrationFile("add_roles_table", dir);
    const createdName = path.basename(created);
    assert(/^\d{14}_add_roles_table\.sql$/.test(createdName), `createMigrationFile generates a timestamped name (${createdName})`);
    await fs.rm(created);
  } finally {
    await pool.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll smoke tests passed.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
