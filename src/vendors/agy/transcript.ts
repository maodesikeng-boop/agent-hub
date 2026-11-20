// Undocumented location, verified locally: conversations/<id>.db is one sqlite file per conversation.
import { join } from "node:path";
import { isFile, safeId, type TranscriptRef, type TranscriptRoots } from "../../daemon/driver/transcript-files.ts";
import { agyCliDataDir, agyDataPaths } from "./paths.ts";

export function agyTranscriptPath(ref: TranscriptRef, roots: TranscriptRoots = {}): string | null {
  const id = ref.vendorSessionId;
  if (!safeId(id)) return null;
  const file = agyDataPaths(agyCliDataDir(roots.home)).conversationDb(id);
  return isFile(file) ? file : null;
}

export function agySessionFiles(ref: TranscriptRef, roots: TranscriptRoots = {}): string[] {
  const id = ref.vendorSessionId;
  if (!safeId(id)) return [];
  const data = agyDataPaths(agyCliDataDir(roots.home));
  const db = data.conversationDb(id);
  return [db, `${db}-wal`, `${db}-shm`, data.brainDir(id), join(data.subDir("annotations"), `${id}.pbtxt`)];
}
