# AutoDev hardened handoff

This archive is the pre-laptop hardened source handoff.

Before deployment or real-target enablement:

1. Run `npm ci` on the trusted Windows development machine.
2. Run `npm run validate:local` and require a complete PASS.
3. Commit/push the exact validated source.
4. Require the `Validate AutoDev` GitHub Actions workflow to PASS for that exact commit.
5. Apply only missing AutoDev D1 migrations through `0008_candidate_lineage_verification.sql`.
6. Perform disposable PASS-path and repair-path end-to-end proofs before enabling any real Assayer target.

The archive intentionally excludes `node_modules` and secret values.
