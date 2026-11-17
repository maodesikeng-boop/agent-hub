// 文件进出（docs/slack-design.md「交付物」）：项目经理发的文件、卡片带的交付物传成 Slack 原生附件；主人在 Slack 里贴的文件存成附件。
// 不变量：
// - 发出去的只有 sent-files 副本和上传目录里的文件（编号从账本来，路径由 resolveUpload 重新算），不按消息里的原路径读盘；
// - 进来的文件只收主人的（访客的在 routing.ts 已丢掉），每个不超过 MAX_UPLOAD_BYTES，一条消息最多 MAX_ATTACHMENTS_PER_MESSAGE 个，
//   超了的跳过并在回执里说明；
// - 同一条消息的第几个文件只传一次（slack_posts 的 file ref）。
import type { Attachment } from "../../shared/attachments.ts";
import type { SlackChannelId } from "../../shared/slack.ts";
import type { SlackInboundFile } from "./inbound.ts";
import type { SlackTransport } from "./transport.ts";

/** 要传的一个文件：已经解析成本机副本。 */
export interface SlackOutboundFile {
  /** 在这条消息里是第几个（slack_posts 的 part）。 */
  index: number;
  path: string;
  name: string;
  title: string;
}

/**
 * 后置：逐个上传到频道主聊天流，返回传成了的 index 和 Slack 文件编号；
 * 单个失败（文件不在了、超过 MAX_SENT_FILE_BYTES、Slack 报错）记进 failed，不影响别的。
 */
export function uploadSlackFiles(
  transport: SlackTransport,
  channelId: SlackChannelId,
  files: readonly SlackOutboundFile[],
): Promise<{ uploaded: { index: number; fileId: string }[]; failed: { index: number; reason: string }[] }> {
  throw new Error("未实现");
}

/**
 * 后置：下载并用 saveUpload 存进上传目录，返回附件（顺序同输入）；超过上限、下载失败的进 skipped（写文件名和原因）。
 */
export function downloadSlackFiles(
  transport: SlackTransport,
  uploadsDir: string,
  files: readonly SlackInboundFile[],
): Promise<{ attachments: Attachment[]; skipped: { name: string; reason: string }[] }> {
  throw new Error("未实现");
}
