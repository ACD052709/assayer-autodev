import { createApiRouter } from "../api/index.js";
import { R2EvidenceBlobStore } from "../evidence/index.js";
import { createD1StateStore } from "../state/d1-store.js";
import type { WorkerEnv } from "./env.js";

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const store = createD1StateStore(env.AUTODEV_DB);
    const blobs = new R2EvidenceBlobStore(env.AUTODEV_EVIDENCE);
    const router = createApiRouter({ store, blobs });
    return router(request);
  },
};
