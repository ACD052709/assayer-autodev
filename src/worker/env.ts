import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export interface WorkerEnv {
  readonly AUTODEV_DB: D1Database;
  readonly AUTODEV_EVIDENCE: R2Bucket;
  readonly ENVIRONMENT: string;
  /** Set via `wrangler secret put AUTODEV_SERVICE_TOKEN` — never commit values. */
  readonly AUTODEV_SERVICE_TOKEN?: string;
  /** Set via `wrangler secret put OPENAI_API_KEY` — never commit values. */
  readonly OPENAI_API_KEY?: string;
  /** Set via `wrangler secret put GITHUB_TOKEN` — triggers workflow_dispatch after dispatch. */
  readonly GITHUB_TOKEN?: string;
  /** Repository slug `owner/repo` for the worker workflow. */
  readonly GITHUB_REPOSITORY?: string;
  readonly GITHUB_WORKFLOW_FILE?: string;
  readonly GITHUB_WORKFLOW_REF?: string;
  readonly GITHUB_EXECUTION_MODE?: string;
  /** Optional default target URL passed to scheduled browser verifier runs. */
  readonly BROWSER_VERIFIER_TARGET_URL?: string;
  /** Workflow file for independent browser verification (default autodev-browser-verifier.yml). */
  readonly GITHUB_VERIFIER_WORKFLOW_FILE?: string;
  readonly GITHUB_PROMOTION_WORKFLOW_FILE?: string;
}
