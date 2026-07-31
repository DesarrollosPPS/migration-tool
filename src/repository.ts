import * as sql from "mssql";

export const DEFAULT_HISTORY_TABLE = "dbo.schema_migrations";

function parseTableName(tableName: string): { schema: string; table: string } {
  const parts = tableName.split(".");
  if (parts.length === 1) return { schema: "dbo", table: parts[0] };
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  throw new Error(`Invalid history table name: ${tableName}`);
}

function escapeIdentifier(identifier: string): string {
  return `[${identifier.replace(/[[\]]/g, "")}]`;
}

function escapedTable(tableName: string): string {
  const { schema, table } = parseTableName(tableName);
  return `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`;
}

function rawTable(tableName: string): string {
  const { schema, table } = parseTableName(tableName);
  return `${schema}.${table}`;
}

export async function ensureHistoryTable(
  pool: sql.ConnectionPool,
  tableName: string = DEFAULT_HISTORY_TABLE,
): Promise<void> {
  const statement = `
    IF OBJECT_ID(N'${rawTable(tableName)}', N'U') IS NULL
    BEGIN
      CREATE TABLE ${escapedTable(tableName)} (
        id INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_schema_migrations PRIMARY KEY,
        name NVARCHAR(255) NOT NULL,
        applied_at DATETIME2 NOT NULL CONSTRAINT DF_schema_migrations_applied_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_schema_migrations_name UNIQUE (name)
      );
    END
  `;
  await pool.request().batch(statement);
}

export async function getAppliedMigrations(
  pool: sql.ConnectionPool,
  tableName: string = DEFAULT_HISTORY_TABLE,
): Promise<Map<string, Date>> {
  const result = await pool.request().query(`SELECT [name], [applied_at] FROM ${escapedTable(tableName)}`);
  const applied = new Map<string, Date>();
  for (const row of result.recordset) {
    applied.set(row.name as string, row.applied_at as Date);
  }
  return applied;
}

export async function recordMigration(
  pool: sql.ConnectionPool,
  migrationName: string,
  tableName: string = DEFAULT_HISTORY_TABLE,
): Promise<void> {
  await pool
    .request()
    .input("name", sql.NVarChar, migrationName)
    .query(`INSERT INTO ${escapedTable(tableName)} ([name]) VALUES (@name)`);
}
