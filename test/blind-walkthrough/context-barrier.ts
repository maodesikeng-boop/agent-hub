// Invariant: no repository path, source identifier, UI test selector, or production credential ever crosses into the blind agent.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { isPathInsideOrEqual, normalizePathForComparison } from "../../src/daemon/platform/index.ts";
import { resolveHubPaths } from "../../src/shared/paths.ts";
import { BLIND_A11Y_MAX_NODES, BLIND_A11Y_SNAPSHOT_MAX_CHARS } from "./limits.ts";
import type { SanitizedA11yNode } from "./types.ts";

export interface PromptCleanOptions {
  readonly repoRoot: string;
  readonly worktreeRoot?: string;
  readonly forbiddenTerms?: readonly string[];
}

export interface PromptLeakViolation {
  readonly rule: string;
  readonly match: string;
}

export interface RawA11yNode {
  readonly role?: string;
  readonly name?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly focused?: boolean;
  readonly testId?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly children?: readonly RawA11yNode[];
}

export interface IsolationCheckOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
  readonly platform?: NodeJS.Platform;
}

const MAX_LINK_HOPS = 40;

const SAFE_BASE_ENV_KEYS = [
  "PATH",
  "Path",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "PATHEXT",
  "ComSpec",
  "WINDIR",
  "NO_COLOR",
] as const;

const FORBIDDEN_ENV_KEYS = new Set(["HUB_TOKEN", "HUB_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]);

const STATIC_LEAK_RULES: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: "source_path", pattern: /\bsrc\/[\w./-]+/gi },
  { rule: "repo_instruction_file", pattern: /\b(?:AGENTS\.md|REVIEW\.md|CLAUDE\.md)\b/g },
  { rule: "test_selector", pattern: /\bdata-testid\b|data-internal-[\w-]+|rail-device-dot-[\w-]*/gi },
  { rule: "internal_env_var", pattern: /\b(?:AGENT_HUB_[A-Z0-9_]+|HUB_TOKEN|HUB_SOCK)\b/g },
  { rule: "internal_auth_token", pattern: /\bui-token\b|\/auth\?token=/gi },
  { rule: "internal_data_dir", pattern: /\.agent-hub(?:[\\/]|$)/gi },
];

function symlinkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function resolveRealPath(rawPath: string, platform: NodeJS.Platform): string {
  if (platform !== process.platform) {
    return platform === "win32" ? win32.resolve(rawPath) : posix.resolve(rawPath);
  }
  let current = resolve(rawPath);
  const rest: string[] = [];
  let hops = 0;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const link = symlinkTarget(current);
      if (link !== undefined) {
        if (++hops > MAX_LINK_HOPS) throw new Error(`Symlink loop exceeded ${MAX_LINK_HOPS} hops for ${rawPath}`);
        current = resolve(dirname(current), link);
        continue;
      }
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

function comparisonKey(pathValue: string, platform: NodeJS.Platform): string {
  const normalized = normalizePathForComparison(pathValue);
  return platform === "darwin" || platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(a: string, b: string, platform: NodeJS.Platform): boolean {
  const keyA = comparisonKey(a, platform);
  const keyB = comparisonKey(b, platform);
  return isPathInsideOrEqual(keyA, keyB) || isPathInsideOrEqual(keyB, keyA);
}

/**
 * Precondition: targetDir is the candidate workspace or temp directory the walkthrough tool wants to create or delete.
 * Postcondition: returns cleanly only when targetDir does not overlap ~/.agent-hub or env AGENT_HUB_HOME after symlink resolution; otherwise throws Error.
 */
export function assertIsolatedWorkspace(targetDir: string, options?: IsolationCheckOptions): void {
  if (targetDir.trim() === "") {
    throw new Error("Target directory must be non-empty for isolated workspace verification");
  }
  const platform = options?.platform ?? process.platform;
  const userHome = options?.userHome ?? homedir();
  const env = options?.env ?? process.env;
  const resolvedTarget = resolveRealPath(targetDir, platform);
  const protectedRoots = new Set<string>([
    resolveRealPath(resolveHubPaths({}, userHome, { platform }).home, platform),
    resolveRealPath(resolveHubPaths(env, userHome, { platform }).home, platform),
  ]);
  for (const root of protectedRoots) {
    if (pathsOverlap(resolvedTarget, root, platform)) {
      throw new Error(`Workspace ${targetDir} (resolved ${resolvedTarget}) overlaps production data directory ${root}; isolated path required`);
    }
  }
}

function addLiteralLeakMatches(
  text: string,
  needle: string,
  rule: string,
  violations: PromptLeakViolation[],
): void {
  const trimmed = needle.trim();
  if (trimmed === "") return;
  const variants = new Set<string>([trimmed, trimmed.replace(/\\/g, "/"), trimmed.replace(/\//g, "\\")]);
  const lowerText = text.toLowerCase();
  for (const variant of variants) {
    if (lowerText.includes(variant.toLowerCase())) {
      violations.push({ rule, match: variant });
      break;
    }
  }
}

/**
 * Precondition: text is any system prompt, mission brief, or observation string about to be sent to the blind agent.
 * Postcondition: returns an empty array when no repository path, source identifier, or internal selector leaks; otherwise returns every matched violation.
 */
export function scanBlindPromptLeaks(text: string, options: PromptCleanOptions): readonly PromptLeakViolation[] {
  const violations: PromptLeakViolation[] = [];
  addLiteralLeakMatches(text, options.repoRoot, "repo_root_path", violations);
  if (options.worktreeRoot) {
    addLiteralLeakMatches(text, options.worktreeRoot, "worktree_root_path", violations);
  }
  for (const term of options.forbiddenTerms ?? []) {
    addLiteralLeakMatches(text, term, "forbidden_term", violations);
  }
  for (const { rule, pattern } of STATIC_LEAK_RULES) {
    const matches = text.match(pattern);
    if (matches) {
      const unique = [...new Set(matches)];
      for (const match of unique) {
        violations.push({ rule, match });
      }
    }
  }
  return violations;
}

/**
 * Precondition: text is any prompt or observation destined for the blind agent.
 * Postcondition: returns cleanly when scanBlindPromptLeaks finds zero violations; otherwise throws Error naming all violations.
 */
export function assertBlindPromptClean(text: string, options: PromptCleanOptions): void {
  const violations = scanBlindPromptLeaks(text, options);
  if (violations.length === 0) return;
  const summary = violations.map((v) => `${v.rule}(${v.match})`).join(", ");
  throw new Error(`Forbidden blind-agent prompt leak detected: ${summary}`);
}

function scrubNodeText(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/\bdata-testid\s*=\s*["']?[^\s"']+["']?/gi, "")
    .replace(/\bdata-internal-[\w-]+\s*=\s*["']?[^\s"']+["']?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatA11yLine(node: SanitizedA11yNode): string {
  const flags: string[] = [];
  if (node.value !== undefined && node.value !== "") flags.push(`value=${JSON.stringify(node.value)}`);
  if (node.disabled) flags.push("disabled");
  if (node.expanded !== undefined) flags.push(`expanded=${String(node.expanded)}`);
  if (node.focused) flags.push("focused");
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return `[${node.role}] ${JSON.stringify(node.name)}${suffix}`;
}

/**
 * Precondition: root is a raw accessibility tree snapshot captured from the browser.
 * Postcondition: strips data-testid and internal attributes, caps node count at BLIND_A11Y_MAX_NODES and serialized text at BLIND_A11Y_SNAPSHOT_MAX_CHARS.
 */
export function sanitizeAccessibilitySnapshot(root: RawA11yNode | null): {
  readonly nodes: readonly SanitizedA11yNode[];
  readonly text: string;
} {
  if (root === null) return { nodes: [], text: "" };
  const nodes: SanitizedA11yNode[] = [];
  const stack: RawA11yNode[] = [root];
  while (stack.length > 0 && nodes.length < BLIND_A11Y_MAX_NODES) {
    const current = stack.pop()!;
    const role = scrubNodeText(current.role) || "generic";
    const name = scrubNodeText(current.name);
    const value = current.value !== undefined ? scrubNodeText(current.value) : undefined;
    if (name !== "" || value !== undefined || role !== "generic") {
      nodes.push({
        role,
        name,
        ...(value !== undefined ? { value } : {}),
        ...(current.disabled ? { disabled: true } : {}),
        ...(current.expanded !== undefined ? { expanded: current.expanded } : {}),
        ...(current.focused ? { focused: true } : {}),
      });
    }
    const children = current.children;
    if (children && children.length > 0) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]!);
      }
    }
  }

  const lines: string[] = [];
  let charCount = 0;
  for (const node of nodes) {
    const line = formatA11yLine(node);
    const addition = lines.length === 0 ? line.length : line.length + 1;
    if (charCount + addition > BLIND_A11Y_SNAPSHOT_MAX_CHARS) break;
    lines.push(line);
    charCount += addition;
  }
  return { nodes, text: lines.join("\n") };
}

function isForbiddenEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return FORBIDDEN_ENV_KEYS.has(upper) || upper.startsWith("AGENT_HUB_");
}

/**
 * Precondition: blindHomeDir is an isolated empty directory outside the repository and production data directory.
 * Postcondition: returns a scrubbed environment containing no HUB_TOKEN, HUB_SOCK, AGENT_HUB_*, GitHub tokens, or SSH agent sockets,
 * while forwarding only explicit caller-approved credential keys from allowEnvKeys when provided.
 */
export function buildBlindAgentEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  blindHomeDir: string,
  platform: NodeJS.Platform = process.platform,
  allowEnvKeys?: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_BASE_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined && !isForbiddenEnvKey(key)) {
      env[key] = value;
    }
  }
  for (const key of allowEnvKeys ?? []) {
    if (isForbiddenEnvKey(key)) continue;
    const value = baseEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.HOME = blindHomeDir;
  env.USERPROFILE = blindHomeDir;
  if (platform === "win32" && !env.LANG) {
    env.LANG = "en_US.UTF-8";
  }
  return env;
}
