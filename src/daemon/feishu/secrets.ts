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

export async function readFeishuSecrets(file: string): Promise<FeishuSecrets | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // A malformed file throws instead of reading as unconfigured, so a later save cannot overwrite the user's credentials.
  const parsed = secretsSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${file} 的格式不对：要有 brand、appId、appSecret`);
  return parsed.data;
}

export async function writeFeishuSecrets(file: string, secrets: FeishuSecrets): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(secretsSchema.parse(secrets), null, 2)}\n`, { mode: FEISHU_SECRETS_FILE_MODE });
}

export async function removeFeishuSecrets(file: string): Promise<void> {
  await rm(file, { force: true });
}
