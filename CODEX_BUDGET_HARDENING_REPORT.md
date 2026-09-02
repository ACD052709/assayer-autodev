# Codex + budget hardening report

## Purpose

Replace the Cursor implementation actuator with a lower-cost Codex coding worker while preserving AutoDev's independent verification and promotion boundaries, and add durable budget controls that pause before new paid work instead of losing project state.

## Implemented

- Codex CLI headless implementation actuator (`codex exec`), pinned to `@openai/codex@0.148.0` for the first disposable proof.
- GPT-5.6 Luna default coding model.
- Repair-attempt routing from durable repair metadata: original + repair 1 Luna, repair 2 Terra, repair 3 Sol; the default repair limit is three, so no fourth repair is created.
- Current GPT-5.6 token-price accounting, including cached reads, 1.25x cache writes, and >272K long-context multipliers.
- Durable `llm_cost_usd` budget resource and in-place budget increase API.
- Dispatcher preflight budget gate and active-worker reservation subtraction.
- `waiting_for_budget` orchestration phase instead of dispatching a new paid attempt without headroom.
- Conservative reservation charge if Codex exits before emitting machine-readable usage.
- Test-passing changed work is captured as a candidate even when Codex itself times out or exits non-zero; independent verification still decides acceptance.
- Structured coding outcome constrained to the existing 16-key lifecycle limit.
- SIGTERM -> SIGKILL timeout escalation for uncooperative subprocesses.
- Optional private-target GitHub read token passed only through ephemeral git HTTP configuration; it is not embedded in the clone URL or persisted remote configuration.
- Deterministic target dependency bootstrap from committed npm/pnpm/yarn lockfiles before paid coding begins.
- Candidate-controlled tests/builds receive a sanitized environment with AutoDev/OpenAI/GitHub credentials removed.
- Cursor installation and Cursor credential use removed from the implementation workflow. The old GitHub Cursor secret may remain temporarily until the Codex disposable smoke passes.
- Codex runs are bounded to a five-minute actuator timeout, `workspace-write`, approval mode `never`, disabled model-shell network access, standard service tier, and disabled code-mode-host/multi-agent/fast-mode features.
- Prompt policy tells Codex to make the smallest bounded patch, not run the authoritative repository test/build itself, not deploy/push, and stop when the requested slice is implemented.


## Validation completed in the handoff environment

- Main TypeScript compile: PASS.
- Cloudflare-worker TypeScript compile: PASS.
- Targeted compiled checks: PASS for Luna -> Luna -> Terra -> Sol routing, reasoning effort, bounded Codex arguments, cache-read/cache-write JSONL usage parsing, standard and long-context pricing, conservative attempt reservations, and the 16-key structured-outcome limit.
- Compiled in-memory budget API smoke: PASS for create -> charge -> increase -> read while preserving prior spend.
- Compiled dispatcher budget smoke: PASS for blocking a $0.10 project before a $0.25 Luna reservation and dispatching normally with sufficient headroom.
- Secret-pattern scan: no real API/PAT credential material detected in the source tree.

## Validation still required on the trusted Windows laptop

The handoff environment inherited Windows `node_modules`, so the Linux host could not execute Vitest because Rollup's Linux optional native package was absent. Do not treat this as a source-test failure.

Run from the actual repository after copying the handoff files:

```bash
npm ci
npm run validate:local
```

Require the complete test suite and Wrangler dry-run to pass before commit, push, or deployment. Then require the GitHub `Validate AutoDev` workflow to pass on the exact commit.

## No schema migration

The dollar budget uses the existing JSON budget ledger/entries schema. Migrations remain through `0008_candidate_lineage_verification.sql`.

## Controlled limitations

- `llm_cost_usd` reservations are AutoDev admission control, not a provider-side exact per-request dollar cap. The OpenAI project/account spend limit remains the emergency outer backstop.
- Active queued/running worker reservations are subtracted during normal dispatch, but the reservation check is not yet a single atomic D1 transaction across truly concurrent dispatcher invocations. Avoid concurrent manual/orchestrator dispatch calls until the disposable E2E proof is complete.
- A deterministic-test-passing patch is persisted even after an abnormal Codex exit. If the provider cuts a request before the patch passes the trusted test, that failing partial workspace is intentionally not promoted/persisted as a candidate.
- Codex 0.148 exposes cache-write token usage in `turn.completed`; the parser also accepts the alternate `cache_write_tokens` spelling for forward compatibility. If terminal usage is absent entirely, AutoDev charges the conservative model reservation.
