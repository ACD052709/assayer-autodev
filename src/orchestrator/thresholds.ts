/** Policy thresholds for bounded orchestration. Override in tests via cycle options. */
export interface OrchestrationThresholds {
  readonly maxRepairAttemptsPerTask: number;
  readonly maxDispatchAssignments: number;
}

export const DEFAULT_ORCHESTRATION_THRESHOLDS: OrchestrationThresholds = {
  maxRepairAttemptsPerTask: 2,
  maxDispatchAssignments: 4,
};
