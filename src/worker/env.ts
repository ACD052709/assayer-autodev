import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export interface WorkerEnv {
  readonly AUTODEV_DB: D1Database;
  readonly AUTODEV_EVIDENCE: R2Bucket;
  readonly ENVIRONMENT: string;
}
