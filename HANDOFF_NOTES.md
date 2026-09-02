# AutoDev Codex + budget handoff

This archive is the hardened source handoff that replaces the Cursor coding actuator with OpenAI Codex while preserving the existing Master, dispatcher, candidate, verifier, repair, auditor, and promotion architecture.

Key changes:

1. Codex CLI implementation worker: GPT-5.6 Luna for original work and repair 1, Terra for repair 2, Sol for repair 3; then the default repair limit stops the chain.
2. Durable `llm_cost_usd` project budget with pre-dispatch headroom checks, active-worker reservation accounting, `waiting_for_budget`, and an in-place budget-increase API.
3. Actual Codex token usage is converted to dollar spend, including cached reads, billed cache writes, and long-context multipliers. Missing terminal usage is charged conservatively at the reservation amount.
4. Passing changed work is captured before interpreting an abnormal Codex exit, so a timeout/non-zero exit does not discard a deterministic-test-passing candidate.
5. Candidate-controlled tests receive a sanitized environment; the OpenAI key is supplied only to the Codex process as `CODEX_API_KEY`.
6. Codex is pinned to 0.148.0 for the first proof and bounded to five minutes, workspace-write, no approval prompts, no model-shell network, standard service tier, and no fast/multi-agent/code-mode-host execution. Timeout escalates from SIGTERM to SIGKILL after a short grace period.

Before deployment or real-target enablement:

1. Run `npm ci` on the trusted Windows development machine.
2. Run `npm run validate:local` and require a complete PASS.
3. Commit/push the exact validated source.
4. Require the `Validate AutoDev` GitHub Actions workflow to PASS for that exact commit.
5. Deploy only the dedicated AutoDev Cloudflare Worker. Migrations remain through `0008_candidate_lineage_verification.sql`; this change adds no D1 migration.
6. Create an `llm_cost_usd` budget for the disposable E2E project before dispatching the coding worker.
7. Perform disposable PASS-path and repair-path end-to-end proofs before enabling any real Assayer target.

The archive intentionally excludes `node_modules`, test artifacts, generated build output, and secret values.

Controlled limitations before scale-out: the internal dollar reservation is admission control rather than an exact provider-side per-request cap; avoid truly concurrent dispatch calls because reservation admission is not yet one atomic D1 transaction. Passing candidates are persisted, but a provider interruption before trusted tests pass can still discard a failing partial workspace by design.
