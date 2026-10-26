import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

function isInside(base: string, target: string): string | undefined {
  const rel = relative(base, target);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

/**
 * Render a path for display without leaking the user's home directory:
 * paths inside the session cwd become relative ("src/cli.ts"), other paths
 * under the home directory become "~/...", and everything else is unchanged.
 */
export function displayPath(
  filePath: string,
  sessionCwd?: string,
): string {
  if (!isAbsolute(filePath)) return filePath;

  if (sessionCwd !== undefined && isAbsolute(sessionCwd)) {
    const rel = isInside(sessionCwd, filePath);
    if (rel !== undefined) return rel === "" ? "." : rel;
  }

  const relHome = isInside(homedir(), filePath);
  if (relHome !== undefined) {
    return relHome === "" ? "~" : `~/${relHome.split(sep).join("/")}`;
  }

  return filePath;
}