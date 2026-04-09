import type { DbClient } from "../db/client";

export class RecoveryService {
  constructor(private readonly db: DbClient) {}

  recover(): void {
    this.db.rebuildProjectionsFromEvents();
  }
}
