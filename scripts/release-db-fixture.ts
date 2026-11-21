// Captures a ledger that a released version really wrote, for test/e2e/release-upgrade.test.ts.
// After tagging a release: node scripts/release-db-fixture.ts vX.Y.Z
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_DB_DIR = fileURLToPath(new URL("../test/fixtures/release-db/", import.meta.url));

export const RELEASE_SAMPLE = {
  pmName: "Release sample PM",
  projectName: "release-sample",
  projectQuestion: "release sample: create the project",
  question: "release sample question",
  answer: "release sample answer",
} as const;

interface SampleDaemon {
  terminate(): Promise<{ code: number | null; signal: string | null }>;
}

interface SampleClient {
  state(): Promise<{ conversations: { conversation: { id: number } }[] }>;
  post(conversationId: number, text: string): Promise<number>;
  createPm(input: { name: string; mode: string; persona: string }): Promise<{ conversationId: number }>;
}

/** The parts of test/e2e/harness.ts that every released version and the working tree share. */
interface SampleHarness {
  makeEnv(): {
    dir: string;
    home: string;
    setScript(script: unknown): void;
    start(): Promise<SampleDaemon>;
    bashRuns(): { exitCode: number; output: string }[];
    cleanup(): Promise<void>;
  };
  Client: { login(daemon: SampleDaemon): Promise<SampleClient> };
  waitForStatus(client: SampleClient, id: number, status: string): Promise<unknown>;
}

// The SQLite header stores user_version as a big-endian integer at byte 60.
export const headerUserVersion = (db: Buffer): number => db.readUInt32BE(60);

const bashPathArg = (path: string) => `'${path.replace(/\\/g, "/").replaceAll("'", "'\\''")}'`;

function extractTag(tag: string, tree: string): void {
  const archive = spawnSync("git", ["archive", "--format=tar", tag, "--", "src", "migrations", "test", "package.json", "apps/desktop"], {
    cwd: REPO_ROOT,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error(`git archive ${tag} failed: ${archive.stderr.toString()}`);
  const untar = spawnSync("tar", ["-x", "-C", tree], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr.toString()}`);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"), "junction");
}

/** Drives a daemon through `harness` and returns the ledger it leaves after a clean shutdown. */
export async function captureSampleLedger(harness: SampleHarness): Promise<Buffer> {
  const env = harness.makeEnv();
  try {
    const folder = join(env.dir, "code", RELEASE_SAMPLE.projectName);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "README.md"), "release sample\n");
    env.setScript({
      turns: [{ steps: [{ bash: `hub project create --folder ${bashPathArg(folder)}` }, { text: RELEASE_SAMPLE.answer }] }],
      defaultTurn: { steps: [{ text: RELEASE_SAMPLE.answer }] },
    });
    const daemon = await env.start();
    const client = await harness.Client.login(daemon);
    const defaultPm = (await client.state()).conversations[0]!.conversation.id;
    await harness.waitForStatus(client, await client.post(defaultPm, RELEASE_SAMPLE.projectQuestion), "replied");
    const created = env.bashRuns()[0];
    if (created?.exitCode !== 0) throw new Error(`hub project create failed: ${created?.output ?? "never ran"}`);
    await harness.waitForStatus(client, await client.post(defaultPm, RELEASE_SAMPLE.question), "replied");
    const pm = await client.createPm({ name: RELEASE_SAMPLE.pmName, mode: "manage_only", persona: "" });
    await harness.waitForStatus(client, await client.post(pm.conversationId, RELEASE_SAMPLE.question), "replied");
    const exit = await daemon.terminate();
    if (exit.code !== 0) throw new Error(`sample daemon exited with ${exit.code ?? exit.signal}`);
    const dbFile = join(env.home, "state", "hub.sqlite");
    if (existsSync(`${dbFile}-wal`)) throw new Error(`${dbFile}-wal is still there after a clean shutdown`);
    return readFileSync(dbFile);
  } finally {
    await env.cleanup();
  }
}

async function main(tag: string | undefined): Promise<void> {
  if (tag === undefined || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("usage: node scripts/release-db-fixture.ts vX.Y.Z");
  const tree = mkdtempSync(join(tmpdir(), "bellwood-release-db-"));
  try {
    extractTag(tag, tree);
    const harness = (await import(pathToFileURL(join(tree, "test", "e2e", "harness.ts")).href)) as SampleHarness;
    const db = await captureSampleLedger(harness);
    mkdirSync(RELEASE_DB_DIR, { recursive: true });
    const out = join(RELEASE_DB_DIR, `${tag}.sqlite.gz`);
    writeFileSync(out, gzipSync(db, { level: 9 }));
    console.log(`${out}: user_version ${headerUserVersion(db)}, ${db.length} bytes, ${readFileSync(out).length} gzipped`);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv[2]);
}
