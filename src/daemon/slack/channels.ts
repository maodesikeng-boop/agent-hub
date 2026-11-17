// 频道同步（docs/slack-design.md）：总助一个私密频道，每个项目经理一个，随新建、改名、归档、取消归档幂等对齐。
// 不变量：
// - 对齐只看账本现状和 slack_channels，不看事件顺序：同一份输入算出同一组操作，重复执行不多建频道；
// - 频道按 slack_channels 里记的编号认，不按名字认（归档的频道仍占着名字，名字可能被别人占）；
// - 用户在 Slack 里自己改了频道名，Fusa 不改回去，只更新记录；项目经理改名时才按新名字改。
import type { Pm } from "../../shared/domain.ts";
import type { SlackChannelId, SlackChannelTarget } from "../../shared/slack.ts";
import type { SlackChannelBinding } from "./store.ts";

/** 账本里应该有的频道。 */
export interface SlackChannelSpec {
  target: SlackChannelTarget;
  /** 总助或项目经理的名字（没规整）。 */
  label: string;
  /** 想要的频道名（已规整）。 */
  name: string;
  /** 频道说明：写清这是 Fusa 的哪个项目经理、在哪台设备上。 */
  purpose: string;
  archived: boolean;
}

/**
 * 后置：总助一个（永不归档）；每个项目经理一个，archived 跟 Pm.archivedAt。
 * 名字 = slackChannelName(设备名, 总助或项目经理的名字)。
 */
export function desiredSlackChannels(pms: readonly Pm[], deviceName: string): SlackChannelSpec[] {
  throw new Error("未实现");
}

/**
 * 后置：Slack 认的频道名：小写，空格和不允许的标点换成“-”，保留中文等其他文字的字母，最长 80 字；
 * 规整完是空的返回 fusa-<设备>-<序号> 这类纯 ASCII 名字。
 */
export function slackChannelName(deviceName: string, label: string): string {
  throw new Error("未实现");
}

export type SlackChannelOp =
  | { kind: "create"; spec: SlackChannelSpec }
  | { kind: "rename"; channelId: SlackChannelId; name: string; label: string }
  | { kind: "archive"; channelId: SlackChannelId }
  | { kind: "unarchive"; channelId: SlackChannelId }
  | { kind: "invite_owner"; channelId: SlackChannelId };

/**
 * 前置：bindings 是 slack_channels 的全部行；ownerIn 回答主人在不在某个频道。
 * 后置：要建的（没有记录的 target）、要改名的（spec.label 和记录的 label 不同，即项目经理改了名）、要归档或取消归档的、
 * 主人不在的未归档频道要拉主人。已对齐时返回空数组。不返回删除：项目经理删掉时频道早已归档。
 */
export function planSlackChannelSync(
  desired: readonly SlackChannelSpec[],
  bindings: readonly SlackChannelBinding[],
  ownerIn: (channelId: SlackChannelId) => boolean,
): SlackChannelOp[] {
  throw new Error("未实现");
}
