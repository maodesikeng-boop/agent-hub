// agy 的原始记录在哪（docs/vendor-plugin-design.md 的 C8，按家分发在 src/daemon/driver/transcript.ts）。
// ~/.gemini/antigravity-cli/conversations/<conversation id>.db（一个 SQLite 文件，一个会话一个）；
// brain/<conversation id>/ 只放它的临时文件（scratch），不是对话内容。官方文档没写这个存储位置，只有本机核对。
import { join } from "node:path";
import { isFile, safeId, type TranscriptRef, type TranscriptRoots } from "../../daemon/driver/transcript-files.ts";
import { agyCliDataDir, agyDataPaths } from "./paths.ts";

export function agyTranscriptPath(ref: TranscriptRef, roots: TranscriptRoots = {}): string | null {
  const id = ref.vendorSessionId;
  if (!safeId(id)) return null;
  const file = agyDataPaths(agyCliDataDir(roots.home)).conversationDb(id);
  return isFile(file) ? file : null;
}

/** 这个会话在 agy 数据目录里留下的：会话库（和 -wal、-shm）、brain/<id>/、annotations/<id>.pbtxt。只算路径，不看在不在。 */
export function agySessionFiles(ref: TranscriptRef, roots: TranscriptRoots = {}): string[] {
  const id = ref.vendorSessionId;
  if (!safeId(id)) return [];
  const data = agyDataPaths(agyCliDataDir(roots.home));
  const db = data.conversationDb(id);
  return [db, `${db}-wal`, `${db}-shm`, data.brainDir(id), join(data.subDir("annotations"), `${id}.pbtxt`)];
}
