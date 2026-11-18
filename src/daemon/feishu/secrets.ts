// 应用凭证文件 state/feishu-secrets.json（docs/feishu-design.md「统一」）。
// 不变量：
// - 文件权限 FEISHU_SECRETS_FILE_MODE（0600），用 write-file-atomic 原子替换，不留半截文件；
// - 实现步骤把 "feishu-secrets.json" 加进 shared/readonly-policy.ts 的 READONLY_SECRET_STATE_FILES，只读 Worker 读不到；
// - App Secret 不进日志、不进任何接口响应。
import type { FeishuBrandName } from "../../shared/feishu.ts";

export interface FeishuSecrets {
  brand: FeishuBrandName;
  appId: string;
  appSecret: string;
}

/** 后置：文件不存在返回 null；形状不对抛错（不当成没配过，免得覆盖用户的凭证）。 */
export function readFeishuSecrets(file: string): Promise<FeishuSecrets | null> {
  throw new Error("未实现");
}

/** 后置：原子写入，权限 0600。 */
export function writeFeishuSecrets(file: string, secrets: FeishuSecrets): Promise<void> {
  throw new Error("未实现");
}

/** 后置：删掉文件；不存在不报错。 */
export function removeFeishuSecrets(file: string): Promise<void> {
  throw new Error("未实现");
}
