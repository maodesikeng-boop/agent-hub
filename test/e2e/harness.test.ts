import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { FakeLogEntry } from "../fake-claude/fake-claude.ts";
import { makeEnv } from "./harness.ts";

it("reads only complete fake Claude records while another process appends", async () => {
  const env = makeEnv();
  const file = join(env.fakeDir, "fake-claude.log");
  const first = { kind: "ready", pid: 11 } satisfies FakeLogEntry;
  const second = { kind: "stdin", pid: 12, line: "hello" } satisfies FakeLogEntry;
  const record = JSON.stringify(second);
  const split = record.indexOf("hello") + 2;
  writeFileSync(file, JSON.stringify(first) + "\n");
  const writer = spawn(process.execPath, ["--input-type=module", "-e", `
    import { appendFileSync } from "node:fs";
    const [file, prefix, suffix] = process.argv.slice(1);
    appendFileSync(file, prefix);
    process.stdout.write("prefix written");
    process.stdin.once("end", () => appendFileSync(file, suffix + "\\n"));
    process.stdin.resume();
  `, file, record.slice(0, split), record.slice(split)], { stdio: ["pipe", "pipe", "inherit"] });
  const closed = once(writer, "close");
  try {
    await Promise.race([
      once(writer.stdout, "data"),
      closed.then(() => { throw new Error("Log writer exited before it wrote the prefix"); }),
    ]);
    expect(env.log()).toEqual([first]);
    writer.stdin.end();
    expect(await closed).toEqual([0, null]);
    expect(env.log()).toEqual([first, second]);

    const third = { kind: "exit", pid: 11, code: 0 } satisfies FakeLogEntry;
    appendFileSync(file, JSON.stringify(third));
    expect(env.log()).toEqual([first, second]);
    appendFileSync(file, "\n");
    expect(env.log()).toEqual([first, second, third]);

    appendFileSync(file, "{broken}\n");
    expect(() => env.log()).toThrow(SyntaxError);
  } finally {
    try {
      if (!writer.stdin.writableEnded) writer.stdin.end();
      await closed;
    } finally {
      writeFileSync(file, "");
      await env.cleanup();
    }
  }
});
