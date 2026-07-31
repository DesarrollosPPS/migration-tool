import * as dotenv from "dotenv";
import path from "node:path";

export interface DatabaseConfig {
  server: string;
  port: number;
  user: string;
  password: string;
  database: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

const DEFAULTS: DatabaseConfig = {
  server: "localhost",
  port: 1433,
  user: "sa",
  password: "YourStrong!Passw0rd",
  database: "migration_tool_test",
  encrypt: true,
  trustServerCertificate: true,
};

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });
  return {
    server: env.DB_HOST ?? DEFAULTS.server,
    port: toNumber(env.DB_PORT, DEFAULTS.port),
    user: env.DB_USER ?? DEFAULTS.user,
    password: env.DB_PASSWORD ?? DEFAULTS.password,
    database: env.DB_NAME ?? DEFAULTS.database,
    encrypt: toBoolean(env.DB_ENCRYPT, DEFAULTS.encrypt),
    trustServerCertificate: toBoolean(env.DB_TRUST_SERVER_CERTIFICATE, DEFAULTS.trustServerCertificate),
  };
}

export function toMssqlConfig(cfg: DatabaseConfig): {
  server: string;
  port: number;
  user: string;
  password: string;
  database: string;
  options: { encrypt: boolean; trustServerCertificate: boolean };
} {
  return {
    server: cfg.server,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    options: {
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCertificate,
    },
  };
}
