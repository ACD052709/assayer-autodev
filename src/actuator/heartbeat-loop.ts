import { ActuatorError } from "./errors.js";
import type { ActuatorTimers } from "./types.js";

export interface HeartbeatLoopOptions {
  readonly intervalMs: number;
  readonly failureLimit: number;
  readonly beat: () => Promise<void>;
  readonly onOwnershipLost: (error: ActuatorError) => void;
  readonly timers: ActuatorTimers;
}

export interface HeartbeatLoop {
  stop(): Promise<void>;
  readonly beatCount: () => number;
}

export function startHeartbeatLoop(options: HeartbeatLoopOptions): HeartbeatLoop {
  let stopped = false;
  let consecutiveFailures = 0;
  let beats = 0;
  let inFlight: Promise<void> | undefined;

  const timerId = options.timers.setInterval(() => {
    if (stopped || inFlight !== undefined) {
      return;
    }
    inFlight = runBeat()
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
      });
  }, options.intervalMs);

  async function runBeat(): Promise<void> {
    if (stopped) {
      return;
    }
    try {
      await options.beat();
      beats += 1;
      consecutiveFailures = 0;
    } catch (error) {
      const actuatorError =
        error instanceof ActuatorError
          ? error
          : new ActuatorError("HEARTBEAT_FAILED", "Heartbeat failed");
      if (actuatorError.ownershipLost) {
        stopTimer();
        options.onOwnershipLost(actuatorError);
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= options.failureLimit) {
        stopTimer();
        options.onOwnershipLost(
          new ActuatorError("HEARTBEAT_LOST", "Heartbeat failed repeatedly", { ownershipLost: true }),
        );
      }
    }
  }

  function stopTimer(): void {
    stopped = true;
    options.timers.clearInterval(timerId);
  }

  return {
    beatCount: () => beats,
    async stop(): Promise<void> {
      stopTimer();
      if (inFlight !== undefined) {
        await inFlight;
      }
    },
  };
}
