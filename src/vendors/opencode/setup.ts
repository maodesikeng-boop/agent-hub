import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { ProviderAuthMethodDescriptor } from "../../shared/index.ts";
import type { VendorSetupAdapter } from "../daemon-types.ts";
import { OPENCODE_DATA_REL } from "./spec.ts";

const OPENCODE_INSTALL_URL = "https://opencode.ai/v2/install";
const OPENCODE_NPM_SPEC = "@opencode/cli";
const API_KEY_ENV = "OPENCODE_API_KEY";

// `opencode auth login` needs an interactive terminal, so the UI offers only the OpenCode Zen key.
const OPENCODE_AUTH_METHODS: readonly ProviderAuthMethodDescriptor[] = [
  { id: "api_key", kind: "api_key", label: "OpenCode Zen API key", placeholder: "sk-..." },
];

function hasLocalAccountStore(userHome: string): boolean {
  const join = /^[A-Za-z]:/.test(userHome) || userHome.includes("\\") ? win32.join : posix.join;
  const dataDir = join(userHome, ...OPENCODE_DATA_REL.split("/"));
  return existsSync(join(dataDir, "opencode.db")) || existsSync(join(dataDir, "auth.json"));
}

export const opencodeSetupAdapter: VendorSetupAdapter = {
  installRecipe(platform) {
    // The npm package must run its postinstall to fetch the native binary.
    if (platform === "win32") return { kind: "npm", packageSpec: OPENCODE_NPM_SPEC };
    return {
      kind: "posix_script",
      scriptUrl: OPENCODE_INSTALL_URL,
      shell: "bash",
      fallback: { kind: "npm", packageSpec: OPENCODE_NPM_SPEC },
    };
  },

  updateRecipe() {
    return { kind: "cli_subcommand", args: ["upgrade"], fallbackToReinstall: true };
  },

  async inspectAuth(ctx) {
    if (ctx.secrets.has("opencode", API_KEY_ENV)) {
      return { accountSummary: "API key configured", canSignOut: true, methods: OPENCODE_AUTH_METHODS };
    }
    if (ctx.availability === "available" || (ctx.installed() && hasLocalAccountStore(ctx.userHome))) {
      return { accountSummary: "Signed in", canSignOut: false, methods: OPENCODE_AUTH_METHODS };
    }
    return { accountSummary: null, canSignOut: false, methods: OPENCODE_AUTH_METHODS };
  },

  async saveApiKey(ctx, { apiKey }) {
    ctx.secrets.set("opencode", { [API_KEY_ENV]: apiKey.trim() });
  },

  // Terminal accounts stay with `opencode auth logout`; only the key Bellwood stored is removed.
  async signOut(ctx) {
    ctx.secrets.remove("opencode");
  },
};
