import { readFileSync } from "node:fs";

/**
 * Single source of truth for the package version. Read from package.json at
 * runtime (relative to this module) so the CLI's `--version`, the MCP server's
 * handshake, and the published version never drift apart. Both `src/core/` and
 * `dist/core/` sit two levels under the package root, so the same relative URL
 * resolves correctly under vitest (source) and when installed (compiled).
 */
const packageJsonUrl = new URL("../../package.json", import.meta.url);

const readVersion = (): string => {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return parsed.version;
  }
  throw new Error("gori: package.json has no string `version` field");
};

export const VERSION = readVersion();
