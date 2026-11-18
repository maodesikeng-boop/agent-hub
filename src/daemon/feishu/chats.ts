// 项目群同步（docs/feishu-design.md「自动建群」）：每个项目经理一个私有对话群，水果头像、群名是项目经理名字、主人是群主，
// 随项目经理新建、改名、归档、取消归档、删除幂等对齐。总助不建群，用主人和机器人的单聊。
// 不变量：
// - 对齐只看账本现状和 feishu_chats，不看事件顺序：同一份输入算出同一组操作，重复执行不多建群；
// - 群按 feishu_chats 里记的编号认，不按群名认；建群请求带 feishuChatCreateUuid，崩在“建好了还没记下”之间时，
//   10 小时内重试不会多建，超过 10 小时由群说明里的 feishuChatMarker 在机器人所在的群里认回来；
// - 用户在飞书里自己改了群名，Fusa 不改回去，只更新记录；项目经理改名时才按新名字改；
// - 项目经理归档时解散它的群（聊天记录随群消失，账本里还在），记录留着、记下归档时间，唤醒方式和访客档位不丢；
//   取消归档时新建一个群，换上新的群编号；项目经理删掉时解散群、删记录。
import type { Pm, PmId } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import type { PmFruit } from "./avatars.ts";
import type { FeishuChatBinding } from "./store.ts";

/** 账本里应该有的项目群。 */
export interface FeishuChatSpec {
  pmId: PmId;
  /** 项目经理的名字（没处理）。 */
  label: string;
  /** 想要的群名：项目经理名字，最长 60 字。 */
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

/**
 * 后置：建群请求的幂等 uuid（≤ 50 字），由应用、设备、项目经理和 generation 定，同一组输入总是同一个。
 * generation 是第一次建群时的 0，取消归档后重建时是上一个群解散时记下的归档时间：每次重建的 uuid 都不同，
 * 不会被飞书当成 10 小时内的重复请求。
 */
export function feishuChatCreateUuid(appId: string, deviceId: string, pmId: PmId, generation: number): string {
  throw new Error("未实现");
}

export type FeishuChatOp =
  /** generation 见 feishuChatCreateUuid。 */
  | { kind: "create"; spec: FeishuChatSpec; generation: number }
  /** 机器人所在的群里有带本项目经理标记的群、记录里却没有：认回来，不新建。 */
  | { kind: "adopt"; chatId: FeishuChatId; spec: FeishuChatSpec }
  | { kind: "rename"; chatId: FeishuChatId; name: string; label: string }
  | { kind: "set_avatar"; chatId: FeishuChatId; fruit: PmFruit }
  /** 项目经理归档：解散群，记录记下归档时间。 */
  | { kind: "dissolve"; chatId: FeishuChatId }
  /** 项目经理已删掉（记录的 pm_id 是 null）：群还在就解散，删记录。 */
  | { kind: "retire"; chatId: FeishuChatId; dissolved: boolean };

/**
 * 前置：bindings 是 feishu_chats 里 target 为 pm 的全部行；markedChats 是机器人所在的群里群说明带 Fusa 标记的（编号 → 标记）。
 * 后置：
 * - 没有记录的未归档项目经理：markedChats 里有它的标记就 adopt，没有才 create（generation 0）；
 * - 有记录、记录已归档、项目经理取消了归档：create，generation 是记录的 archivedAt；
 * - 有记录、未归档、项目经理归档了：dissolve；已归档的记录不再出 rename、set_avatar；
 * - 未归档的记录：label 变了 rename，水果变了 set_avatar；
 * - pm_id 为 null 的记录 retire（记录已归档时 dissolved 为 true，不再解散）；
 * - 没有记录的已归档项目经理什么都不做。已对齐时返回空数组。
 */
export function planFeishuChatSync(
  desired: readonly FeishuChatSpec[],
  bindings: readonly FeishuChatBinding[],
  markedChats: ReadonlyMap<FeishuChatId, string>,
  deviceId: string,
): FeishuChatOp[] {
  throw new Error("未实现");
}
