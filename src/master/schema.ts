export const MASTER_OUTPUT_SCHEMA_NAME = "master_decision";

/** Strict JSON Schema for OpenAI Responses structured outputs. */
export const MASTER_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "rationale",
    "claimedFinished",
    "humanApprovalReason",
    "blockerSummaries",
    "taskProposals",
  ],
  properties: {
    action: {
      type: "string",
      enum: [
        "CREATE_TASKS",
        "WAIT_FOR_WORKERS",
        "REQUEST_VERIFICATION",
        "REQUEST_HUMAN_APPROVAL",
        "REPLAN",
        "FINAL_ACCEPTANCE",
        "FINISHED",
        "BLOCKED",
      ],
    },
    rationale: { type: "string" },
    claimedFinished: { type: "boolean" },
    humanApprovalReason: { type: "string" },
    blockerSummaries: {
      type: "array",
      items: { type: "string" },
    },
    taskProposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "clientKey",
          "title",
          "description",
          "kind",
          "dependencyClientKeys",
          "existingDependencyIds",
        ],
        properties: {
          clientKey: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          kind: {
            type: "string",
            enum: ["planning", "implementation", "verification", "deployment", "acceptance"],
          },
          dependencyClientKeys: {
            type: "array",
            items: { type: "string" },
          },
          existingDependencyIds: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
  },
} as const;
