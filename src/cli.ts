#!/usr/bin/env node
import * as sql from "mssql";
import { loadConfigFromEnv, toMssqlConfig } from "./config";
import { createMigrationFile } from "./migration";
import { getStatus, MigrationError, runMigrations } from "./runner";

const USAGE = `migrate - SQL Server migration tool

Usage: migrate <command> [options]

Commands:
  up [--to <prefix>]   Apply all pending migrations (optionally up to a name/prefix)
  status               Show applied and pending migrations
  create <name>        Create a new timestamped migration file

Options:
  --dir <path>   Migrations directory (default: ./migrations)
  --to <prefix>  For "up": only apply migrations whose name starts with the prefix
  -h, --help     Show this help
`;

interface CliOptions {
  dir?: string;
  to?: string;
}

function parseArgs(args: string[]): { command: string; options: CliOptions; rest: string[] } {
  const options: CliOptions = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") options.dir = args[++i];
    else if (arg.startsWith("--dir=")) options.dir = arg.slice("--dir=".length);
    else if (arg === "--to") options.to = args[++i];
    else if (arg.startsWith("--to=")) options.to = arg.slice("--to=".length);
    else rest.push(arg);
  }
  return { command: rest.shift() ?? "", options, rest };
}

async function connectAnd<T>(fn: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = new sql.ConnectionPool(toMssqlConfig(loadConfigFromEnv()));
  await pool.connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

async function main(): Promise<void> {
  const { command, options, rest } = parseArgs(process.argv.slice(2));

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === "create") {
    const description = rest.join(" ");
    if (!description) {
      console.error("Error: create requires a description, e.g. `migrate create add_users_table`");
      process.exitCode = 1;
      return;
    }
    const file = await createMigrationFile(description, options.dir);
    console.log(`Created ${file}`);
    return;
  }

  if (command !== "up" && command !== "status") {
    console.error(`Error: unknown command "${command}"`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  await connectAnd(async (pool) => {
    if (command === "status") {
      const rows = await getStatus({ pool, migrationsDir: options.dir });
      for (const row of rows) {
        const when = row.appliedAt ? ` (applied ${row.appliedAt.toISOString()})` : "";
        console.log(`[${row.status.padEnd(7)}] ${row.name}${when}`);
      }
      return;
    }
    const result = await runMigrations({
      pool,
      migrationsDir: options.dir,
      target: options.to,
      logger: (message) => console.log(message),
    });
    console.log(`Applied ${result.applied.length} migration(s), skipped ${result.skipped.length}.`);
  });
}

main().catch((err: unknown) => {
  if (err instanceof MigrationError) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
});
