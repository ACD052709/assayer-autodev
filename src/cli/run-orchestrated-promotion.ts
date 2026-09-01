import { createPromotionControlPlaneClient, runOrchestratedPromotion } from "../persistence/control-plane-client.js";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runOrchestratedPromotion({
    ...options,
    client: createPromotionControlPlaneClient(),
  });
  console.log("Promotion completed");
}

function parseArgs(argv: string[]): {
  promotionRunId: string;
  projectId: string;
  codeCandidateId: string;
  taskId: string;
  workerRunId: string;
  verifierRunId: string;
  destinationRepository: string;
  destinationRef: string;
  workDir: string;
} {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    values[key] = argv[i + 1] ?? "";
    i += 1;
  }
  const required = [
    "promotion-run-id",
    "project-id",
    "code-candidate-id",
    "task-id",
    "worker-run-id",
    "verifier-run-id",
    "destination-repository",
    "destination-ref",
    "work-dir",
  ];
  for (const field of required) {
    if ((values[field] ?? "").length === 0) {
      throw new Error(`Missing required argument: --${field}`);
    }
  }
  return {
    promotionRunId: values["promotion-run-id"]!,
    projectId: values["project-id"]!,
    codeCandidateId: values["code-candidate-id"]!,
    taskId: values["task-id"]!,
    workerRunId: values["worker-run-id"]!,
    verifierRunId: values["verifier-run-id"]!,
    destinationRepository: values["destination-repository"]!,
    destinationRef: values["destination-ref"]!,
    workDir: values["work-dir"]!,
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
