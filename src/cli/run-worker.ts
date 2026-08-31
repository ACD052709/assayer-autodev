import { createControlPlaneClient } from "../actuator/control-plane-client.js";
import { ActuatorError } from "../actuator/errors.js";
import { runActuator } from "../actuator/executor.js";
import { createSanitizingLogger } from "../actuator/logger.js";
import { parseActuatorCli } from "../actuator/parse-cli.js";

function installProcessSignals(handler: () => void): () => void {
  const wrapped = (): void => {
    handler();
  };
  process.on("SIGTERM", wrapped);
  process.on("SIGINT", wrapped);
  return () => {
    process.off("SIGTERM", wrapped);
    process.off("SIGINT", wrapped);
  };
}

async function main(argv: string[]): Promise<number> {
  const env = {
    ...(process.env.AUTODEV_SERVICE_TOKEN !== undefined
      ? { AUTODEV_SERVICE_TOKEN: process.env.AUTODEV_SERVICE_TOKEN }
      : {}),
    ...(process.env.AUTODEV_CONTROL_PLANE_URL !== undefined
      ? { AUTODEV_CONTROL_PLANE_URL: process.env.AUTODEV_CONTROL_PLANE_URL }
      : {}),
    ...(process.env.GITHUB_REPOSITORY !== undefined
      ? { GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY }
      : {}),
    ...(process.env.GITHUB_RUN_ID !== undefined ? { GITHUB_RUN_ID: process.env.GITHUB_RUN_ID } : {}),
    ...(process.env.GITHUB_RUN_ATTEMPT !== undefined
      ? { GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT }
      : {}),
  };
  const secrets = [env.AUTODEV_SERVICE_TOKEN];
  const logger = createSanitizingLogger(secrets);

  try {
    const config = parseActuatorCli(argv, env);
    const client = createControlPlaneClient({
      controlPlaneUrl: config.controlPlaneUrl,
      serviceToken: config.serviceToken,
    });
    const result = await runActuator({
      config,
      client,
      logger,
      installSignalHandlers: installProcessSignals,
    });
    return result.exitCode;
  } catch (error) {
    const message = error instanceof ActuatorError ? error.message : "Actuator failed";
    logger.error(message, error instanceof ActuatorError ? { code: error.code } : undefined);
    return 1;
  }
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
