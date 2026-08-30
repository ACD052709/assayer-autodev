# assayer-autodev

Autonomous development and verification orchestration system for Assayer.

This repository contains a **TypeScript orchestration foundation** with typed domain models, an in-memory state store for local tests, and a **Cloudflare Worker control plane** (D1 + R2) for durable state and evidence storage. External integrations (AI providers, Cursor ACP, Playwright, GitHub, Assayer) are intentionally **not connected yet**.

## Architecture

```mermaid
flowchart TB
  subgraph clients [Future clients]
    MA[Master AI Director]
    WK[Task Workers]
    VF[Verifier]
    DB[Dashboard]
  end

  subgraph control [Cloudflare Control Plane]
    API[Worker HTTP API]
    D1[(D1 AUTODEV_DB)]
    R2[(R2 AUTODEV_EVIDENCE)]
  end

  subgraph local [Local / tests]
    MEM[InMemoryStateStore]
    IBLOB[InMemoryEvidenceBlobStore]
  end

  MA --> API
  WK --> API
  VF --> API
  DB --> API
  API --> D1
  API --> R2
  MEM -.->|same StateStore contract| D1
```

### Module layout

```
src/
├── domain/           # Typed models, lifecycle enums, provenance
├── state/
│   ├── store.ts      # StateStore (sync, in-memory)
│   ├── async-store.ts
│   ├── in-memory-store.ts
│   ├── d1-store.ts   # D1StateStore (AsyncStateStore)
│   └── d1/           # D1 mappers + test SQLite adapter
├── evidence/
│   ├── blob-store.ts # EvidenceBlobStore interface
│   ├── in-memory-blob-store.ts
│   └── r2-blob-store.ts
├── api/
│   ├── router.ts     # JSON HTTP API
│   ├── validation.ts
│   └── middleware/auth.ts  # stub — add auth before deploy
└── worker/
    └── index.ts      # Cloudflare Worker entry
migrations/
└── 0001_initial.sql  # D1 schema
wrangler.toml         # placeholder bindings (no resources provisioned)
```

### D1 vs R2 roles

| Store | Role |
|-------|------|
| **D1 (`AUTODEV_DB`)** | Structured durable state: projects, tasks, workers, verification, permissions, budget, master inbox metadata |
| **R2 (`AUTODEV_EVIDENCE`)** | Large evidence blobs (screenshots, logs, artifacts). D1 `evidence` rows hold metadata + `content_ref` pointer |

Evidence metadata lives in D1; blob bytes live in R2 (or in-memory during tests).

### StateStore migration path

- `StateStore` — original sync interface used by `InMemoryStateStore`
- `AsyncStateStore` — async mirror for D1 and HTTP handlers
- `asAsyncStore()` — wraps sync store for API tests
- `D1StateStore` / `createD1StateStore()` — production persistence via D1

Domain types are shared; only the persistence adapter changes.

### HTTP API (control plane)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/health` | Liveness |
| GET | `/api/projects/:projectId/state` | Project + master state |
| GET | `/api/projects/:projectId/tasks` | List tasks |
| GET | `/api/tasks/:taskId` | Get task |
| GET | `/api/tasks/:taskId/evidence` | Evidence metadata for task |
| GET | `/api/master/inbox?projectId=` | Master inbox (newest first) |
| POST | `/api/projects` | Create project |
| POST | `/api/requirements` | Create requirement |
| POST | `/api/tasks` | Create task |
| POST | `/api/worker-runs` | Create worker run |
| POST | `/api/worker-events` | Append worker event |
| POST | `/api/worker-reports` | Create worker report |
| POST | `/api/test-results` | Record test result |
| POST | `/api/evidence` | Create evidence (+ optional `blobBase64` → R2) |
| POST | `/api/verifier-runs` | Create or complete verifier run |
| POST | `/api/master/inbox` | Enqueue master inbox item |

## Control-plane security model

This API is **private machine-to-machine infrastructure**. It is not a browser-facing service.

| Control | Behavior |
|---------|----------|
| Authentication | Protected routes require `Authorization: Bearer <token>` |
| Secret binding | `AUTODEV_SERVICE_TOKEN` via `wrangler secret put` — **never** in source, tests, README examples, or `.env.example` |
| Fail closed | Protected routes return `503 auth_misconfigured` if the secret is missing at runtime |
| Roles (V1) | Route policies declare `master`, `worker`, `verifier`, `admin`; the service token maps temporarily to `admin` |
| Request limits | JSON metadata max **256 KiB**; invalid `Content-Length` rejected |
| Evidence bootstrap | `blobBase64` is **temporary** — max decoded **64 KiB** for small test blobs only |
| Future evidence | Production uploads should go **directly to controlled R2 paths**, not giant JSON bodies |
| Content-Type | POST JSON routes require `application/json` (`415` otherwise) |
| CORS | **No wildcard CORS** — not enabled |
| Errors | No stack traces, secrets, SQL, or env vars in client responses |
| Headers | `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` |
| `/health` | Unauthenticated minimal `{ "status": "ok" }` only |

**Do not deploy to Cloudflare without setting `AUTODEV_SERVICE_TOKEN`.** This is required for the first private deployment.

### Setting the service token (when deploying)

```bash
npx wrangler secret put AUTODEV_SERVICE_TOKEN
```

Do not paste the token into any file tracked by git.

## Local development

**Requirements:** Node.js 20+

```bash
npm install

# Type-check domain + tests
npm run typecheck

# Type-check Worker (Cloudflare types)
npm run typecheck:worker

# Run all tests (in-memory + API + D1 via local SQLite — no Cloudflare account)
npm run test

# Validate Worker bundle (no deploy, no account required for dry-run bundling)
npm run worker:validate
```

Copy `.env.example` to `.env` when provisioning Cloudflare resources later.

### D1 migrations (when ready to provision)

After creating a real D1 database and updating `database_id` in `wrangler.toml`:

```bash
npx wrangler d1 migrations apply assayer-autodev-db --local   # local dev
npx wrangler d1 migrations apply assayer-autodev-db --remote  # production
```

## What remains intentionally unconnected

- OpenAI / Anthropic API clients
- Cursor ACP actuator
- Playwright browser automation
- GitHub / GitHub Actions
- Assayer product integration
- Cloudflare resource provisioning (placeholder IDs in `wrangler.toml`)
- Per-role token issuance (V1 uses one service token mapped to admin)
- Direct-to-R2 presigned/large evidence uploads
- Production deployment without `AUTODEV_SERVICE_TOKEN`

## License

Private project — not for public distribution.
