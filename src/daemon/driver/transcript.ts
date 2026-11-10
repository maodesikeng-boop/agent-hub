// 会话的“原始记录在哪”：我们不存会话原文，只在账本 agent_sessions 里记 vendor、vendor_session_id、cwd；
// 具体内容在各家厂商自己的目录里，各家的找法在 src/vendors/<厂商>/transcript.ts（daemon.ts 的 transcriptPath），这里只按家分发
// （hub worker show 的“原始记录”那一行、交接提示词用）。算不出来、文件不存在、这家没写找法都返回 null（“找不到”），不猜。
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import { isAgentVendor } from "../../shared/vendors.ts";
import type { TranscriptRef, TranscriptRoots } from "./transcript-files.ts";

export type { TranscriptRef, TranscriptRoots } from "./transcript-files.ts";

/** 按厂商分发；不认识的厂商、没写找法的厂商返回 null。 */
export function vendorTranscriptPath(ref: TranscriptRef, roots: TranscriptRoots = {}): string | null {
  if (!isAgentVendor(ref.vendor)) return null;
  return VENDOR_DAEMONS[ref.vendor].transcriptPath?.(ref, roots) ?? null;
}
