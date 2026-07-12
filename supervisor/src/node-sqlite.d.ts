declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(filename: string);
    exec(sql: string): void;
    close(): void;
  }
}
