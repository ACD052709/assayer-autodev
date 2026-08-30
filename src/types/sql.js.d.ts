declare module "sql.js" {
  export interface SqlJsStatic {
    Database: new () => SqlJsDatabase;
  }

  export interface SqlJsDatabase {
    exec(sql: string): void;
    run(sql: string, params?: unknown[]): void;
    prepare(sql: string): SqlJsStatement;
    getRowsModified(): number;
  }

  export interface SqlJsStatement {
    bind(values?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  export default function initSqlJs(): Promise<SqlJsStatic>;
}
