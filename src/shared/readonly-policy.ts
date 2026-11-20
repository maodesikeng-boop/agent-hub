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

export const READONLY_SECRET_GLOBS: readonly string[] = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*"];

const READONLY_CONNECTORS: Readonly<ReadonlyPolicy["connectors"]> = { extraAllow: [], deny: [] };

export interface ReadonlyPolicyInput {
  homeDir: string;
  stateDir: string;
  protectedRoots?: readonly string[];
  connectors?: Partial<ReadonlyPolicy["connectors"]>;
  dataDirScope?: DataDirReadScope;
  dataDirDenied?: readonly string[];
}

function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${rel.replace(/\//g, sep)}`;
}

export function buildReadonlyPolicy(input: ReadonlyPolicyInput): ReadonlyPolicy {
  return {
    secretPaths: READONLY_SECRET_HOME_PATHS.map((p) => joinPath(input.homeDir, p)),
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
