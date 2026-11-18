// 接入与设置（docs/feishu-design.md「扫码接入」）：界面服务的飞书接口和终端命令（src/feishu/cli.ts 经 run/admin.sock）都只调这里，
// 两处行为一致。
// 不变量：
// - 同一时间最多一次扫码在进行；新的开始会取消旧的；
// - 凭证验过才存：换得到 tenant_access_token、拿得到机器人信息；不对时原有的凭证和连接不动；
// - 扫码建应用时主人就是扫码的人，不用绑定码；手动接入才发绑定码，码只在内存里，一次一个，FEISHU_BIND_CODE_TTL_MS 后失效，用一次作废；
// - 任何返回值都不含 App Secret。
import type {
  FeishuBindCodeResponse,
  FeishuChatPolicyRequest,
  FeishuChatView,
  FeishuCredentialsRequest,
  FeishuDisconnectRequest,
  FeishuStatusView,
} from "../../shared/feishu.ts";

/** 凭证不对、状态不允许：message 是给人看的，界面服务回 400。 */
export class FeishuSetupError extends Error {}

export interface FeishuSetupService {
  status(): FeishuStatusView;
  /**
   * 后置：开始扫码建应用，立刻返回 registering 状态（带确认页链接和过期时间），后台等用户确认；
   * 确认后存凭证、认扫码人为主人、连长连接、建群；拒绝或过期时回到原来的状态，lastError 写原因。
   */
  startRegistration(): Promise<FeishuStatusView>;
  /** 后置：取消正在进行的扫码；没有在扫的不报错。 */
  cancelRegistration(): FeishuStatusView;
  /** 后置：手动接入。验过就存、重连，返回 connecting 或 awaiting_owner；不对抛 FeishuSetupError。换了应用时旧的主人和群记录清空。 */
  saveCredentials(input: FeishuCredentialsRequest): Promise<FeishuStatusView>;
  /** 前置：已接应用、还没认主人。后置：发新码，旧码作废；已有主人时抛 FeishuSetupError。 */
  issueBindCode(): FeishuBindCodeResponse;
  /** 后置：text（去掉首尾空白）是当前有效的码返回 true 并作废它；否则 false。 */
  consumeBindCode(text: string, now: number): boolean;
  /** 后置：改这个项目群的唤醒方式和访客档位，群里那张访客权限卡跟着改；没有这个群抛 FeishuSetupError。 */
  setChatPolicy(input: FeishuChatPolicyRequest): Promise<FeishuChatView>;
  /** 后置：照账本把项目群对一遍（chats.ts），返回对完的状态。没连上时抛 FeishuSetupError。 */
  resync(): Promise<FeishuStatusView>;
  /** 后置：断开连接，删掉凭证文件和四张表；dissolveChats 为 true 时先解散 Fusa 建的项目群。 */
  disconnect(input: FeishuDisconnectRequest): Promise<FeishuStatusView>;
}
