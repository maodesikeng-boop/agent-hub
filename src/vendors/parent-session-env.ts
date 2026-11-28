import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../shared/hub-env.ts";
import { VENDOR_PATHS } from "./paths-registry.ts";
import { VENDOR_LIST } from "./registry.ts";

export const PARENT_SESSION_ENV: readonly string[] = [
  ...new Set([
    ...VENDOR_LIST.flatMap(({ id }) => VENDOR_PATHS[id].parentSessionEnv ?? []),
    "T3CODE_THREAD_ID",
    "T3CODE_CLI_PATH",
    ENV_HUB_TOKEN,
    ENV_HUB_SOCK,
  ]),
];
