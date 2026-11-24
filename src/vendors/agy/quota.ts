import { join } from "node:path";
import { fileStamp } from "../_common/setup/file-stamp.ts";
import { agyCliDataDir } from "./paths.ts";

export function agyQuotaScope(home: string): string {
  const config = agyCliDataDir(home);
  return JSON.stringify([
    fileStamp(join(home, ".gemini", "oauth_creds.json")),
    fileStamp(join(config, "cache", "acp-auth-state.json")),
    fileStamp(join(config, "settings.json")),
  ]);
}
