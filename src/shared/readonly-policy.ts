// Paths must already be realpath'd: macOS /var is /private/var and sandboxes match real paths.

import { CREDENTIAL_HOME_PATHS } from "./secret-paths.ts";
import type { DataDirReadScope } from "./write-scope.ts";
import { VENDOR_LIST } from "../vendors/registry.ts";

export interface ConnectorToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface ReadonlyPolicy {
  secretPaths: string[];
  secretGlobs: string[];
  connectors: { extraAllow: string[]; deny: string[] };
  stateDir?: string;
  protectedRoots?: string[];
  dataDirScope?: DataDirReadScope;
  dataDirDenied?: string[];
}

export const READONLY_SECRET_HOME_PATHS: readonly string[] = [
  ...CREDENTIAL_HOME_PATHS,
  ...VENDOR_LIST.flatMap((spec) => spec.home.readonlySecrets),
];

/** Code host CLI logins (and the keychain `gh` keeps its token in) that a watch command may read to ask about checks. */
export const WATCH_READABLE_HOME_PATHS: readonly string[] = [".config/gh", ".config/hub", ".git-credentials", "Library/Keychains"];

export const WATCH_SECRET_HOME_PATHS: readonly string[] = READONLY_SECRET_HOME_PATHS.filter((p) => !WATCH_READABLE_HOME_PATHS.includes(p));

export const READONLY_SECRET_GLOBS: readonly string[] = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*"];

const READONLY_CONNECTORS: Readonly<ReadonlyPolicy["connectors"]> = { extraAllow: [], deny: [] };

export interface ReadonlyPolicyInput {
  homeDir: string;
  /** Defaults to READONLY_SECRET_HOME_PATHS. */
  homeSecrets?: readonly string[];
  stateDir: string;
  protectedRoots?: readonly string[];
  connectors?: Partial<ReadonlyPolicy["connectors"]>;
  dataDirScope?: DataDirReadScope;
  dataDirDenied?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${rel.replace(/\//g, sep)}`;
}

// A vendor home override (CODEX_HOME, KIMI_CODE_HOME, ...) moves that vendor's secrets out of the default home.
function overriddenHomeSecretPaths(env: Readonly<Record<string, string | undefined>>, homeSecrets: readonly string[]): string[] {
  return VENDOR_LIST.flatMap(({ home }) => {
    const base = home.configHome && env[home.configHome.env]?.trim();
    if (!home.configHome || !base) return [];
    const prefix = `${home.configHome.rel}/`;
    return home.readonlySecrets.filter((rel) => rel.startsWith(prefix) && homeSecrets.includes(rel)).map((rel) => joinPath(base, rel.slice(prefix.length)));
  });
}

export function buildReadonlyPolicy(input: ReadonlyPolicyInput): ReadonlyPolicy {
  const homeSecrets = input.homeSecrets ?? READONLY_SECRET_HOME_PATHS;
  return {
    secretPaths: [
      ...new Set([
        ...homeSecrets.map((p) => joinPath(input.homeDir, p)),
        ...overriddenHomeSecretPaths(input.env ?? process.env, homeSecrets),
      ]),
    ],
    secretGlobs: [...READONLY_SECRET_GLOBS],
    stateDir: input.stateDir,
    connectors: {
      extraAllow: [...(input.connectors?.extraAllow ?? READONLY_CONNECTORS.extraAllow)],
      deny: [...(input.connectors?.deny ?? READONLY_CONNECTORS.deny)],
    },
    ...(input.protectedRoots && input.protectedRoots.length > 0
      ? { protectedRoots: [...input.protectedRoots] }
      : {}),
    ...(input.dataDirScope === undefined
      ? {}
      : { dataDirScope: { ...input.dataDirScope, readable: [...input.dataDirScope.readable], connectable: [...input.dataDirScope.connectable] } }),
    ...(input.dataDirDenied === undefined ? {} : { dataDirDenied: [...input.dataDirDenied] }),
  };
}

function connectorRuleMatches(rule: string, server: string, tool: string): boolean {
  const slash = rule.indexOf("/");
  const ruleServer = slash < 0 ? rule : rule.slice(0, slash);
  const ruleTool = slash < 0 ? "*" : rule.slice(slash + 1);
  return (ruleServer === "*" || ruleServer === server) && (ruleTool === "*" || ruleTool === tool);
}

export function connectorToolAllowed(
  policy: Pick<ReadonlyPolicy, "connectors">,
  server: string,
  tool: string,
  annotations: ConnectorToolAnnotations | null | undefined,
): boolean {
  const { extraAllow, deny } = policy.connectors;
  if (deny.some((rule) => connectorRuleMatches(rule, server, tool))) return false;
  if (extraAllow.some((rule) => connectorRuleMatches(rule, server, tool))) return true;
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
}
