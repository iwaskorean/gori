import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DIR_NAME = ".gori";
const GORI_HOME_ENV = "GORI_HOME";

/**
 * Resolves the storage root: $GORI_HOME when set, otherwise ~/.gori.
 * Overridable via the environment for test isolation and data migration.
 * Takes env as an argument so it stays a pure, testable function.
 */
export const resolveGoriHome = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const override = env[GORI_HOME_ENV]?.trim();
  if (override) return override;
  return join(homedir(), DEFAULT_DIR_NAME);
};

/** Storage path helpers. */
export const tasksDir = (goriHome: string): string => join(goriHome, "tasks");

export const sessionsDir = (goriHome: string): string =>
  join(goriHome, "sessions");

export const taskDir = (goriHome: string, taskId: string): string =>
  join(tasksDir(goriHome), taskId);
