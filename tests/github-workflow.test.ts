import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/autodev-worker.yml"),
  "utf8",
);
const verifierWorkflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/autodev-browser-verifier.yml"),
  "utf8",
);
const promotionWorkflow = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/autodev-promote.yml"),
  "utf8",
);

describe("GitHub Actions worker workflow", () => {
  it("is workflow_dispatch only with least-privilege permissions", () => {
    expect(workflow).toMatch(/^\s*on:\s*$/m);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).not.toMatch(/^\s+pull_request:/m);
    expect(workflow).not.toMatch(/^\s+schedule:/m);
    expect(workflow).toContain("permissions:");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("actions: write");
  });

  it("does not clone Assayer or use Cloudflare/OpenAI secrets", () => {
    expect(workflow.toLowerCase()).not.toContain("assayer-production");
    expect(workflow).not.toMatch(/assayer\/assayer/i);
    expect(workflow).not.toContain("CLOUDFLARE");
    expect(workflow).not.toContain("OPENAI_API_KEY");
    expect(workflow).not.toContain("wrangler deploy");
    expect(workflow).not.toContain("d1 execute");
  });

  it("references the service token only from GitHub Secrets", () => {
    expect(workflow).toContain("secrets.AUTODEV_SERVICE_TOKEN");
    expect(workflow).not.toMatch(/AUTODEV_SERVICE_TOKEN:\s*[A-Za-z0-9_-]{8,}/);
    expect(workflow).not.toContain("echo $AUTODEV_SERVICE_TOKEN");
    expect(workflow).not.toContain("leaseToken");
  });

  it("allows synthetic-noop and coding-task executionMode", () => {
    expect(workflow).toContain("synthetic-noop");
    expect(workflow).toContain("coding-task");
    expect(workflow).not.toContain("cursor-acp");
    expect(workflow).not.toContain("--command");
  });
});

describe("GitHub Actions browser verifier workflow", () => {
  it("is workflow_dispatch only and does not use Cursor credentials", () => {
    expect(verifierWorkflow).toContain("workflow_dispatch:");
    expect(verifierWorkflow).toContain("verifierRunId:");
    expect(verifierWorkflow).toContain("orchestrated-verifier");
    expect(verifierWorkflow).toContain("secrets.AUTODEV_SERVICE_TOKEN");
    expect(verifierWorkflow).not.toContain("CURSOR_API_KEY");
    expect(verifierWorkflow).not.toContain("executionMode");
    expect(verifierWorkflow).toContain("playwright install");
  });
});


describe("GitHub Actions verified promotion workflow", () => {
  it("is dispatch-only with separate write credential and no Cursor/verifier credential leakage", () => {
    expect(promotionWorkflow).toContain("workflow_dispatch:");
    expect(promotionWorkflow).toContain("orchestrated-promotion");
    expect(promotionWorkflow).toContain("baseCommitSha:");
    expect(promotionWorkflow).toContain("secrets.AUTODEV_PROMOTION_GITHUB_TOKEN");
    expect(promotionWorkflow).toContain("secrets.AUTODEV_SERVICE_TOKEN");
    expect(promotionWorkflow).not.toContain("CURSOR_API_KEY");
    expect(promotionWorkflow).not.toContain("playwright");
    expect(promotionWorkflow).not.toContain("push --force");
    expect(promotionWorkflow).not.toContain("--force-with-lease");
    expect(promotionWorkflow).toContain("permissions:");
    expect(promotionWorkflow).toContain("contents: read");
  });
});
