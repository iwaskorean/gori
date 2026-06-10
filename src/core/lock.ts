import { open, rm, stat } from "node:fs/promises";

const RETRY_MS = 20;
const TIMEOUT_MS = 5_000;
const STALE_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Remove the lockfile if it looks orphaned (older than STALE_MS). */
const breakIfStale = async (lockPath: string): Promise<void> => {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > STALE_MS) {
      await rm(lockPath, { force: true });
    }
  } catch {
    // already gone — ignore
  }
};

/**
 * Minimal advisory file lock. Serializes writes through an O_EXCL lockfile so
 * two concurrent peer processes on the same machine don't corrupt shared files.
 */
export const withLock = async <T>(
  lockPath: string,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await breakIfStale(lockPath);
      if (Date.now() > deadline) {
        throw new Error(`gori: timed out acquiring lock (${lockPath})`);
      }
      await sleep(RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
};
