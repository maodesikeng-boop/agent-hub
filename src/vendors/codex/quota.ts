import { join } from "node:path";
import type { QuotaResponse } from "../../shared/index.ts";
import { vendorConfigHome } from "../../shared/paths.ts";
import { fileStamp } from "../_common/setup/file-stamp.ts";
import type { VendorQuotaQuery } from "../daemon-types.ts";
import { CodexRpcError, queryCodexAppServer } from "./catalog.ts";
import { parseCodexRateLimits } from "./protocol.ts";

export function codexQuotaScope(home: string, env: NodeJS.ProcessEnv): string {
  const config = vendorConfigHome("codex", home, env)!;
  return JSON.stringify([config, fileStamp(join(config, "auth.json")), fileStamp(join(config, "config.toml"))]);
}

export async function queryCodexQuota({ path, ...options }: VendorQuotaQuery): Promise<QuotaResponse | null> {
  try {
    const [result] = await queryCodexAppServer({ ...options, codexPath: path }, [{ method: "account/rateLimits/read", params: {} }]);
    const info = parseCodexRateLimits(result);
    return { groups: info === null ? [] : [{ vendor: "codex", id: "codex", windows: info.windows }] };
  } catch (err) {
    if (err instanceof CodexRpcError && /^(chatgpt|codex account) authentication required to read rate limits$/.test(err.rpcMessage)) return null;
    throw err;
  }
}
