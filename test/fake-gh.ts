import { delimiter, dirname, join } from "node:path";
import { readJsonLog } from "./append-log.ts";
import { writeExecutableNodeScript } from "./fake-cli-shim.ts";

export interface FakeGhCall {
  args: string[];
  env: { GH_TOKEN?: string; GH_PROMPT_DISABLED?: string; GH_NO_UPDATE_NOTIFIER?: string };
  cwd: string;
}

/**
 * Writes a Node `gh` stand-in into `<root>/fake-gh-bin` that appends each call to `<root>/gh-calls.jsonl`, then runs `body`
 * with `args` (argv after the program) in scope. Returns a PATH value that puts the fake first and keeps node reachable.
 */
export function installFakeGh(root: string, body: string): string {
  const bin = join(root, "fake-gh-bin");
  const log = join(root, "gh-calls.jsonl");
  writeExecutableNodeScript(
    join(bin, "gh"),
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const pick = (k) => (process.env[k] === undefined ? {} : { [k]: process.env[k] });
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: { ...pick("GH_TOKEN"), ...pick("GH_PROMPT_DISABLED"), ...pick("GH_NO_UPDATE_NOTIFIER") }, cwd: process.cwd() }) + "\\n");
${body}
`,
  );
  return `${bin}${delimiter}${dirname(process.execPath)}`;
}

export function readFakeGhCalls(root: string): FakeGhCall[] {
  return readJsonLog<FakeGhCall>(join(root, "gh-calls.jsonl"));
}
