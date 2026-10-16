import { getSessionEntries, resolveSessionPath } from "./session-reader";
import type { ProfileContext } from "./omp/profile-context";
import type { SessionEntry } from "./types";
import {
  isBashOutputPathReferencedByEntries,
  isFilePathReferencedByEntries,
  isValidSessionId,
} from "./session-file-references-core";

export { isFilePathReferencedByEntries } from "./session-file-references-core";

async function isPathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  check: (p: string, entries: SessionEntry[]) => boolean,
  ctx: ProfileContext,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId, ctx);
    if (!sessionPath) return false;
    return check(filePath, getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}

// Session ids are not unique across profiles, so every caller must pass the
// request's profile: resolving through the process default would both 403 a
// valid non-default request and authorise a path against another profile's
// transcript.
export function isFilePathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  ctx: ProfileContext,
): Promise<boolean> {
  return isPathReferencedBySession(filePath, sessionId, isFilePathReferencedByEntries, ctx);
}

export function isBashOutputPathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  ctx: ProfileContext,
): Promise<boolean> {
  return isPathReferencedBySession(filePath, sessionId, isBashOutputPathReferencedByEntries, ctx);
}
