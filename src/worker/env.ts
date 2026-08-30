import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export interface WorkerEnv {
  readonly AUTODEV_DB: D1Database;
  readonly AUTODEV_EVIDENCE: R2Bucket;
  readonly ENVIRONMENT: string;
  /** Set via `wrangler secret put AUTODEV_SERVICE_TOKEN` — never commit values. */
  readonly AUTODEV_SERVICE_TOKEN?: string;
  /** Set via `wrangler secret put OPENAI_API_KEY` — never commit values. */
  readonly OPENAI_API_KEY?: string;
}
