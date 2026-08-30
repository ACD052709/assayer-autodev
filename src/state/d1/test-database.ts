import initSqlJs, { type SqlJsDatabase } from "sql.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database, D1ExecResult, D1Result } from "@cloudflare/workers-types";

type SqlValue = string | number | null | boolean | Uint8Array;

let sqlJsPromise: ReturnType<typeof initSqlJs> | undefined;

async function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs();
  }
  return sqlJsPromise;
}

function loadMigrationSql(): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return files.map((name) => readFileSync(join(dir, name), "utf8")).join("\n");
}

function meta(changes = 0, rowsRead = 0): D1Result["meta"] {
  return {
    changes,
    last_row_id: 0,
    duration: 0,
    rows_read: rowsRead,
    rows_written: changes,
    size_after: 0,
    changed_db: changes > 0,
  };
}

class SqlJsPreparedStatement {
  private bindings: SqlValue[] = [];

  constructor(
    private readonly db: SqlJsDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.bindings = values.map((v) => {
      if (v === undefined) return null;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
        return v;
      }
      if (v instanceof Uint8Array) {
        return v;
      }
      return String(v);
    });
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    try {
      if (this.bindings.length > 0) {
        stmt.bind(this.bindings);
      }
      if (stmt.step()) {
        return stmt.getAsObject() as T;
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.db.run(this.sql, this.bindings);
    const changes = this.db.getRowsModified();
    return { success: true, results: [], meta: meta(changes) };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const results: T[] = [];
    try {
      if (this.bindings.length > 0) {
        stmt.bind(this.bindings);
      }
      while (stmt.step()) {
        results.push(stmt.getAsObject() as T);
      }
    } finally {
      stmt.free();
    }
    return { success: true, results, meta: meta(0, results.length) };
  }
}

class SqlJsD1Database {
  constructor(private readonly db: SqlJsDatabase) {}

  prepare(query: string): SqlJsPreparedStatement {
    return new SqlJsPreparedStatement(this.db, query);
  }

  async batch<T = Record<string, unknown>>(statements: SqlJsPreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const stmt of statements) {
      results.push(await stmt.run<T>());
    }
    return results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.db.exec(query);
    return { count: 0, duration: 0 };
  }
}

export async function createTestD1Database(migrationSql?: string): Promise<D1Database> {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  db.exec(migrationSql ?? loadMigrationSql());
  return new SqlJsD1Database(db) as unknown as D1Database;
}

export function applyMigration(db: D1Database, sql: string): Promise<D1ExecResult> {
  return db.exec(sql);
}
