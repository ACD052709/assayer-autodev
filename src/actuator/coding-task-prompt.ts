import type { WorkerTaskPacket } from "../domain/worker-task-packet.js";
import { parseRepairTaskContext, stripRepairTaskContext } from "../orchestrator/repair-context.js";

const MAX_PROMPT_CHARS = 12_000;

function bulletLines(items: readonly { readonly id: string; readonly text: string }[]): string {
  if (items.length === 0) {
    return "- (none)";
  }
  return items.map((item) => `- [${item.id}] ${item.text}`).join("\n");
}

/**
 * Bounded, non-interactive prompt for Cursor CLI headless execution.
 * Must not include secrets or environment values.
 */
export function buildCodingTaskPrompt(packet: WorkerTaskPacket): string {
  const requirements = bulletLines(
    packet.requirements.map((req) => ({ id: req.id, text: `${req.title}: ${req.description}` })),
  );
  const acceptance = bulletLines(
    packet.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.description,
    })),
  );
  const blockers = bulletLines(
    packet.blockers.map((blocker) => ({ id: blocker.id, text: blocker.summary })),
  );
  const constraints = bulletLines(
    packet.doNotModifyConstraints.map((constraint, index) => ({
      id: `constraint-${index + 1}`,
      text: constraint,
    })),
  );

  const repairContext = parseRepairTaskContext(packet.task.description);
  const repairSection =
    repairContext === undefined
      ? []
      : [
          "Repair scope (fix only this verification failure):",
          `- Original task: ${repairContext.originalTaskId}`,
          `- Failed verifier run: ${repairContext.verifierRunId}`,
          `- Repair attempt: ${repairContext.attempt}`,
          `- Failure evidence: ${repairContext.failureSummary}`,
          "- Do not expand scope beyond the reported failure.",
        ];

  const prompt = [
    "You are an unattended coding worker executing a bounded Master task.",
    "Authority limits:",
    "- Edit files only inside the provided workspace checkout.",
    "- Do not push, merge, deploy, or run production actions.",
    "- Do not modify assayer-autodev or any secrets.",
    "- Do not decide final task acceptance; tests and Master verification happen later.",
    "",
    `Task ID: ${packet.taskId}`,
    `Worker run ID: ${packet.workerRunId}`,
    `Objective: ${packet.task.title}`,
    `Description: ${stripRepairTaskContext(packet.task.description)}`,
    "",
    ...repairSection,
    ...(repairSection.length > 0 ? [""] : []),
    "Approved requirements:",
    requirements,
    "",
    "Acceptance criteria:",
    acceptance,
    "",
    "Open relevant blockers:",
    blockers,
    "",
    "Do-not-modify constraints:",
    constraints,
    "",
    "Complete only the bounded implementation work needed for this task inside the checkout.",
  ].join("\n");

  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
}
