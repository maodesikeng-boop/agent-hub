// 应用凭证文件 state/feishu-secrets.json（docs/feishu-design.md「统一」）。
// 不变量：
// - 文件权限 FEISHU_SECRETS_FILE_MODE（0600），用 write-file-atomic 原子替换，不留半截文件；
// - "feishu-secrets.json" 在 shared/readonly-policy.ts 的 READONLY_SECRET_STATE_FILES 里，只读 Worker 读不到；
// - App Secret 不进日志、不进任何接口响应。
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { FEISHU_BRANDS, type FeishuBrandName } from "../../shared/feishu.ts";
import { FEISHU_SECRETS_FILE_MODE } from "../../shared/limits.ts";

export interface FeishuSecrets {
  brand: FeishuBrandName;
  appId: string;
  appSecret: string;
}

const secretsSchema = z.object({ brand: z.enum(FEISHU_BRANDS), appId: z.string().min(1), appSecret: z.string().min(1) });

/** 后置：文件不存在返回 null；形状不对抛错（不当成没配过，免得覆盖用户的凭证）。 */
export async function readFeishuSecrets(file: string): Promise<FeishuSecrets | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = secretsSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${file} 的格式不对：要有 brand、appId、appSecret`);
  return parsed.data;
}

/** 后置：原子写入，权限 0600。 */
export async function writeFeishuSecrets(file: string, secrets: FeishuSecrets): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(secretsSchema.parse(secrets), null, 2)}\n`, { mode: FEISHU_SECRETS_FILE_MODE });
}

/** 后置：删掉文件；不存在不报错。 */
export async function removeFeishuSecrets(file: string): Promise<void> {
  await rm(file, { force: true });
}
