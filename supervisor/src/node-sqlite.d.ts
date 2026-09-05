// The pinned @types/node (20.x) predates `node:sqlite`; these ambient
// declarations cover the subset the state store uses.
declare module "node:sqlite" {
  export class StatementSync {
    run(...params: unknown[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  }
  export class DatabaseSync {
    constructor(filename: string);
    readonly isTransaction: boolean;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
