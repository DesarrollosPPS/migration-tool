import * as sql from "mssql";
import type { DatabaseConfig } from "./config";
import { toMssqlConfig } from "./config";
import {
  discoverMigrations,
  resolveMigrationsDir,
  resolveTarget,
  type Migration,
} from "./migration";
import {
  DEFAULT_HISTORY_TABLE,
  ensureHistoryTable,
  getAppliedMigrations,
  recordMigration,
} from "./repository";

export class MigrationError extends Error {
  constructor(
    public readonly migrationName: string,
    public readonly cause: unknown,
  ) {
    super(
      `Migration "${migrationName}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "MigrationError";
  }
}

export interface RunOptions {
  config?: DatabaseConfig;
  pool?: sql.ConnectionPool;
  migrationsDir?: string;
  historyTable?: string;
  target?: string;
  logger?: (message: string) => void;
}

export interface RunResult {
  applied: string[];
  skipped: string[];
  pending: string[];
  migrationsDir: string;
}

export interface MigrationStatus {
  name: string;
  timestamp: number;
  description: string;
  status: "applied" | "pending";
  appliedAt: Date | null;
}

const noopLogger = () => {};

export async function withPool<T>(
  options: RunOptions,
  fn: (pool: sql.ConnectionPool) => Promise<T>,
): Promise<T> {
  if (options.pool) {
    return fn(options.pool);
  }
  if (!options.config) {
    throw new Error("Either `pool` or `config` must be provided");
  }
  const pool = new sql.ConnectionPool(toMssqlConfig(options.config));
  await pool.connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

export async function applyMigration(pool: sql.ConnectionPool, migration: Migration): Promise<void> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    for (const batch of migration.batches) {
      await new sql.Request(transaction).batch(batch);
    }
    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

export async function runMigrations(options: RunOptions): Promise<RunResult> {
  const logger = options.logger ?? noopLogger;
  const migrationsDir = resolveMigrationsDir(options.migrationsDir);
  const historyTable = options.historyTable ?? DEFAULT_HISTORY_TABLE;

  return withPool(options, async (pool) => {
    await ensureHistoryTable(pool, historyTable);

    const all = await discoverMigrations(migrationsDir);
    const cutoff = resolveTarget(options.target, all);
    const appliedMap = await getAppliedMigrations(pool, historyTable);
    const appliedSet = new Set(appliedMap.keys());

    const skipped: string[] = [];
    const pending: Migration[] = [];
    for (const migration of all) {
      if (appliedSet.has(migration.name)) {
        skipped.push(migration.name);
      } else if (cutoff === undefined || migration.timestamp <= cutoff) {
        pending.push(migration);
      }
    }

    const applied: string[] = [];
    for (const migration of pending) {
      try {
        await applyMigration(pool, migration);
      } catch (err) {
        throw new MigrationError(migration.name, err);
      }
      await recordMigration(pool, migration.name, historyTable);
      applied.push(migration.name);
      logger(`Applied ${migration.name}`);
    }

    return { applied, skipped, pending: pending.map((m) => m.name), migrationsDir };
  });
}

export async function getStatus(options: RunOptions): Promise<MigrationStatus[]> {
  const migrationsDir = resolveMigrationsDir(options.migrationsDir);
  const historyTable = options.historyTable ?? DEFAULT_HISTORY_TABLE;

  return withPool(options, async (pool) => {
    await ensureHistoryTable(pool, historyTable);
    const applied = await getAppliedMigrations(pool, historyTable);
    const all = await discoverMigrations(migrationsDir);
    return all.map((m) => ({
      name: m.name,
      timestamp: m.timestamp,
      description: m.description,
      status: applied.has(m.name) ? "applied" : "pending",
      appliedAt: applied.get(m.name) ?? null,
    }));
  });
}
