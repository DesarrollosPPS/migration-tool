import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MIGRATIONS_DIR = "migrations";

const MIGRATION_FILE_PATTERN = /^(\d{14})_([a-z0-9_]+)\.sql$/i;

export interface Migration {
  name: string;
  path: string;
  timestamp: number;
  description: string;
  batches: string[];
}

export function parseMigrationName(name: string): { timestamp: number; description: string } | null {
  const match = MIGRATION_FILE_PATTERN.exec(name);
  if (!match) return null;
  return { timestamp: Number(match[1]), description: match[2] };
}

export function resolveMigrationsDir(dir?: string): string {
  return dir ? path.resolve(dir) : path.resolve(process.cwd(), DEFAULT_MIGRATIONS_DIR);
}

export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}` +
    `${pad(date.getUTCSeconds())}`
  );
}

export function sanitizeDescription(description: string): string {
  const cleaned = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) {
    throw new Error("Migration description must contain at least one letter or digit");
  }
  return cleaned;
}

export async function discoverMigrations(dir: string): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Migrations directory not found: ${dir}`);
    }
    throw err;
  }
  const migrations = entries
    .map((name) => {
      const parsed = parseMigrationName(name);
      if (!parsed) return null;
      return {
        name,
        path: path.join(dir, name),
        timestamp: parsed.timestamp,
        description: parsed.description,
        batches: [] as string[],
      };
    })
    .filter((m): m is Migration => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(migrations.map(readMigration));
}

export async function readMigration(migration: Migration): Promise<Migration> {
  const raw = await fs.readFile(migration.path, "utf8");
  const content = raw.replace(/^\uFEFF/, "");
  const batches = content
    .split(/^GO\s*$/im)
    .map((batch) => batch.trim())
    .filter((batch) => batch.length > 0);
  return { ...migration, batches };
}

export async function createMigrationFile(description: string, dir?: string): Promise<string> {
  const migrationsDir = resolveMigrationsDir(dir);
  await fs.mkdir(migrationsDir, { recursive: true });
  const base = sanitizeDescription(description);
  const now = new Date();
  let candidate = now;
  let name: string;
  do {
    name = `${formatTimestamp(candidate)}_${base}.sql`;
    candidate = new Date(candidate.getTime() + 1000);
  } while (existsSync(path.join(migrationsDir, name)));

  const filePath = path.join(migrationsDir, name);
  const template = `-- Migration: ${name}
-- Created at ${now.toISOString()}
-- Describe what this migration does.

`;
  await fs.writeFile(filePath, template, "utf8");
  return filePath;
}

export function resolveTarget(target: string | undefined, migrations: Migration[]): number | undefined {
  if (target === undefined) return undefined;
  const exact = migrations.find((m) => m.name === target);
  if (exact) return exact.timestamp;
  const prefixMatches = migrations.filter((m) => m.name.startsWith(target));
  if (prefixMatches.length > 0) return prefixMatches[prefixMatches.length - 1].timestamp;
  throw new Error(`No migration matches target "${target}"`);
}
