import { createApiRouter } from "../api/index.js";
import { R2EvidenceBlobStore } from "../evidence/index.js";
import { createMasterOrchestrator, OpenAIMasterModelClient } from "../master/index.js";
import { createD1StateStore } from "../state/d1-store.js";
import type { WorkerEnv } from "./env.js";

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const store = createD1StateStore(env.AUTODEV_DB);
    const blobs = new R2EvidenceBlobStore(env.AUTODEV_EVIDENCE);
    const openaiKey = env.OPENAI_API_KEY?.trim();
    const masterOrchestrator =
      openaiKey !== undefined && openaiKey.length > 0
        ? createMasterOrchestrator({
            store,
            client: new OpenAIMasterModelClient({ apiKey: openaiKey }),
          })
        : undefined;
    const router = createApiRouter({
      deps: {
        store,
        blobs,
        ...(masterOrchestrator !== undefined ? { masterOrchestrator } : {}),
      },
      auth: {
        serviceToken: env.AUTODEV_SERVICE_TOKEN,
        production: env.ENVIRONMENT !== "local",
      },
    });
    return router(request);
  },
};
