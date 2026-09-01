# AutoDev pre-deploy checklist

Use this checklist on the trusted development machine before deploying the hardened control plane or enabling a real target.

## 1. Start from the hardened repository

Do not merge an older Part 7 working copy over this tree. Preserve the old folder separately until this version passes validation.

## 2. Install dependencies for the current operating system

```bash
npm ci
```

Do not reuse `node_modules` copied from another operating system.

## 3. Run the complete local gate

```bash
npm run validate:local
```

This command must finish successfully. It runs, in order:

- main TypeScript typecheck;
- worker TypeScript typecheck;
- complete Vitest suite;
- Cloudflare Worker dry-run validation.

A failure in any stage blocks deployment.

## 4. Review migration state

The hardened source contains migrations through `0008_candidate_lineage_verification.sql`. Apply only migrations that are not already present in the dedicated AutoDev D1 database. Do not apply these migrations to an Assayer product database.

## 5. Confirm credential boundaries

Required runtime credentials belong in their existing secret stores, not source files. Never put token values in `.env.example`, workflow YAML, README files, or committed configuration.

Implementation, browser verification, and promotion remain separate workflow roles. The browser verifier must not receive implementation-agent credentials, and candidate-controlled subprocesses must not inherit AutoDev secrets.

## 6. Deploy only the AutoDev control plane

The first hardened deployment is an AutoDev infrastructure deployment. Do not point the system at Assayer production or preview as part of deployment validation.

## 7. Run disposable end-to-end proofs

Before enabling a real project, prove both paths against a disposable target:

1. PASS path: Master -> dispatch -> implementation candidate -> deterministic tests -> exact-candidate browser verification -> controlled promotion -> Master completion state.
2. REPAIR path: intentionally failing candidate -> independent verifier FAIL -> bounded repair -> chained repaired candidate -> re-verification PASS -> controlled promotion.

Confirm the auditor records no unexplained stuck workers, retry loops, duplicate work, missing reports, verifier mismatches, or budget anomalies.

## 8. Real-target enablement gate

A real Assayer task remains disabled until both disposable proofs pass and the resulting candidate/provenance records identify the exact base SHA, candidate ID, verifier run, verification outcome, and promoted ref.

## 9. Preserve a server-side validation signal

After the hardened source is pushed, confirm the `Validate AutoDev` GitHub Actions workflow passes for the exact commit being deployed. This workflow uses no application secrets and runs the same `npm run validate:local` gate as the trusted development machine.

Do not deploy a different commit than the one that passed both the local gate and the repository validation workflow.
