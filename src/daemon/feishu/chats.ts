// 项目群同步（docs/feishu-design.md「自动建群」）：每个项目经理一个私有对话群，水果头像、群名是项目经理名字、主人是群主，
// 随项目经理新建、改名、归档、取消归档、删除幂等对齐。总助不建群，用主人和机器人的单聊。
// 不变量：
// - 对齐只看账本现状和 feishu_chats，不看事件顺序：同一份输入算出同一组操作，重复执行不多建群；
// - 群按 feishu_chats 里记的编号认，不按群名认；建群请求带 feishuChatCreateUuid，崩在“建好了还没记下”之间时，
//   10 小时内重试不会多建，超过 10 小时由群说明里的 feishuChatMarker 在机器人所在的群里认回来；
// - 用户在飞书里自己改了群名，Fusa 不改回去，只更新记录；项目经理改名时才按新名字改；
// - 归档不解散群（解散会丢聊天记录）：群名加“（已归档）”，群里发一句说明；取消归档改回来。
import type { Pm, PmId } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import type { PmFruit } from "./avatars.ts";
import type { FeishuChatBinding } from "./store.ts";

/** 账本里应该有的项目群。 */
export interface FeishuChatSpec {
  pmId: PmId;
  /** 项目经理的名字（没处理）。 */
  label: string;
  /** 想要的群名：项目经理名字，归档时加“（已归档）”，最长 60 字。 */
  name: string;
  /** 群说明：写清是哪台设备上 Fusa 的哪个项目经理，末尾带 feishuChatMarker。 */
  description: string;
  fruit: PmFruit;
  archived: boolean;
}

/** 后置：每个项目经理一个（含已归档的）；name、fruit 照上面的规则；deviceName 只进说明，不进群名。 */
export function desiredFeishuChats(pms: readonly Pm[], deviceName: string): FeishuChatSpec[] {
  throw new Error("未实现");
}

/** 后置：写进群说明的机器可读标记，如“fusa:<设备编号>:pm:<编号>”；同一台设备、同一个项目经理总是同一个。 */
export function feishuChatMarker(deviceId: string, pmId: PmId): string {
  throw new Error("未实现");
}

/** 后置：建群请求的幂等 uuid（≤ 50 字），只由应用、设备和项目经理定，同一组输入总是同一个。 */
export function feishuChatCreateUuid(appId: string, deviceId: string, pmId: PmId): string {
  throw new Error("未实现");
}

export type FeishuChatOp =
  | { kind: "create"; spec: FeishuChatSpec }
  /** 机器人所在的群里有带本项目经理标记的群、记录里却没有：认回来，不新建。 */
  | { kind: "adopt"; chatId: FeishuChatId; spec: FeishuChatSpec }
  | { kind: "rename"; chatId: FeishuChatId; name: string; label: string }
  | { kind: "set_avatar"; chatId: FeishuChatId; fruit: PmFruit }
  | { kind: "archive"; chatId: FeishuChatId; name: string }
  | { kind: "unarchive"; chatId: FeishuChatId; name: string }
  /** 项目经理已删掉（记录的 pm_id 是 null）：群名加“（已删除）”、发说明、删记录。 */
  | { kind: "retire"; chatId: FeishuChatId };

/**
 * 前置：bindings 是 feishu_chats 里 target 为 pm 的全部行；markedChats 是机器人所在的群里群说明带 Fusa 标记的（编号 → 标记）。
 * 后置：没有记录的项目经理先看 markedChats 里有没有它的标记，有就 adopt，没有才 create；label 变了 rename；
 * 水果变了 set_avatar；归档状态变了 archive / unarchive；pm_id 为 null 的记录 retire。已对齐时返回空数组。
 */
export function planFeishuChatSync(
  desired: readonly FeishuChatSpec[],
  bindings: readonly FeishuChatBinding[],
  markedChats: ReadonlyMap<FeishuChatId, string>,
  deviceId: string,
): FeishuChatOp[] {
  throw new Error("未实现");
}
