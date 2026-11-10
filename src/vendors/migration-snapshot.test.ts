// 厂商迁移（docs/vendor-plugin-design.md 第 5 节）前的行为快照：P2～P4 搬家时这里必须原样通过（P4 的 A13、A15 是有意的行为变化，
// 单独改快照并在 PR 里说明）。只读内存里的常量和纯函数，不起进程、不联网。
// 快照里不能有随机器变的东西：用户主目录一律传占位符 HOME，提示词的工作目录用一个不存在的固定路径（needsAgentsNote 查不到文件就不加那句）。
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildLaunchPrompt, buildWorkerPrompt } from "../daemon/prompt.ts";
import { projectContext, workerContext } from "../daemon/test-helpers.ts";
import { VENDOR_FALLBACK_PATHS } from "../shared/paths.ts";
import { HANDOVER_TOKEN_THRESHOLD } from "../shared/limits.ts";
import { AGENT_VENDORS, VENDOR_FAILURE_SIGNS, agentLaunchArgs, type AgentVendor } from "../shared/vendors.ts";
import { VENDOR_LIST } from "./registry.ts";
import type { VendorSpec } from "./types.ts";

const HOME = "<HOME>";
const PLATFORMS = ["darwin", "linux"] as const;
/** 不存在的工作目录：提示词里不会出现它，needsAgentsNote 也不会读到本机文件。 */
const CWD = "/nonexistent/agent-hub-migration-snapshot";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 每个快照落盘前都过一遍：本机主目录、仓库路径不许出现（出现说明哪里没换成占位符）。 */
function portable<T>(value: T): T {
  const text = JSON.stringify(value, (_key, v: unknown) => (typeof v === "function" || v instanceof RegExp ? String(v) : v));
  for (const local of [homedir(), ROOT]) expect(text).not.toContain(local);
  return value;
}

const show = (v: string | null) => (v === null ? "null" : v === "" ? '""' : v);

/**
 * 迁移前的平铺形状（P1 时的 VENDOR_SPECS，P4 删掉了生产代码里的派生）：快照比的就是它，所以在这里照原样从 spec 拼出来，
 * 字段、顺序和当时 shared/vendors.ts 的 flatSpec 一样。spec 里后来加的字段（cli.installCommand、tools……）不在里面。
 */
function flatSpec(spec: VendorSpec) {
  const { cli, models, capabilities } = spec;
  return {
    label: spec.label,
    loginCommand: cli.loginCommand,
    models: models.bundled,
    customModel: models.customModel,
    customModelExample: models.customModelExample,
    efforts: models.efforts,
    ...(models.effortInModelId === undefined ? {} : { effortInModelId: models.effortInModelId }),
    ...(models.flags === undefined ? {} : { modelFlag: models.flags.model, effortFlag: models.flags.effort, flags: models.flags }),
    ...(spec.quota === undefined ? {} : { quota: spec.quota }),
    ...(models.shortName === undefined ? {} : { shortModelName: models.shortName }),
    backgroundCommands: capabilities.backgroundWake,
    cliCommand: cli.command,
    envVar: cli.envVar,
    subagentTools: spec.prompt.subagentTools,
    backgroundCommandTool: spec.prompt.backgroundCommandTool,
    readonlyMode: capabilities.readonly,
    explicitDefaultModel: capabilities.explicitDefaultModel ?? false,
    handoverTokenThreshold: spec.handover?.tokenThreshold ?? HANDOVER_TOKEN_THRESHOLD,
    composer: spec.composer,
  };
}

const VENDOR_SPECS = Object.fromEntries(VENDOR_LIST.map((spec) => [spec.id, flatSpec(spec)])) as Record<AgentVendor, ReturnType<typeof flatSpec>>;
/** 迁移前的 VENDOR_HOME_PATHS：spec 的 home 去掉 configHome。 */
const VENDOR_HOME_PATHS = Object.fromEntries(
  VENDOR_LIST.map(({ id, home }) => [id, { dirs: home.dirs, readonlySecrets: home.readonlySecrets, catalogWatchPaths: home.catalogWatchPaths }]),
);

/** 每家的模型取值：默认、空串、打包的、名单外的完整模型名，思考程度写在 ID 里的（agy）再加一个带档位的。 */
function modelChoices(vendor: AgentVendor): (string | null)[] {
  const spec = VENDOR_SPECS[vendor];
  const ids = spec.models.map((m) => m.id);
  const withEffort = spec.effortInModelId ? [`${ids[0]}-${spec.efforts.at(-1)}`] : [];
  return [null, "", ...ids, "custom-model-1", ...withEffort];
}

describe("迁移前快照：声明表", () => {
  it("VENDOR_SPECS", () => {
    expect(portable(VENDOR_SPECS)).toMatchSnapshot();
  });

  it("VENDOR_SPECS 里 shortModelName 的结果（函数本身只能存名字，按样例存输出）", () => {
    const samples = [
      ...new Set([
        ...AGENT_VENDORS.flatMap((v) => VENDOR_SPECS[v].models.map((m) => m.id)),
        "claude-sonnet-5-5",
        "claude-opus-4-1-20250805",
        "claude-sonnet-5-5[1m]",
        "claude-3-5-sonnet-latest",
        "gemini-4-argon",
        "gemini-3.8-flash",
        "gpt-oss-120b",
        "gpt-6.1-sol",
        "gpt-6",
        "unknown-model",
      ]),
    ];
    const out = Object.fromEntries(
      AGENT_VENDORS.map((v) => [v, Object.fromEntries(samples.map((m) => [m, VENDOR_SPECS[v].shortModelName?.(m) ?? null]))]),
    );
    expect(portable(out)).toMatchSnapshot();
  });

  it("VENDOR_HOME_PATHS", () => {
    expect(portable(VENDOR_HOME_PATHS)).toMatchSnapshot();
  });

  it("VENDOR_FAILURE_SIGNS", () => {
    expect(portable(VENDOR_FAILURE_SIGNS)).toMatchSnapshot();
  });

  it("VENDOR_FALLBACK_PATHS（主目录换成占位符，macOS、Linux 各一份）", () => {
    expect(Object.keys(VENDOR_FALLBACK_PATHS)).toEqual([...AGENT_VENDORS]);
    const out = Object.fromEntries(
      AGENT_VENDORS.map((v) => [v, Object.fromEntries(PLATFORMS.map((p) => [p, VENDOR_FALLBACK_PATHS[v](HOME, p)]))]),
    );
    expect(portable(out)).toMatchSnapshot();
  });
});

describe("迁移前快照：agentLaunchArgs", () => {
  it.each(AGENT_VENDORS)("%s：模型 × 思考程度各组合", (vendor) => {
    const efforts = [null, "", ...VENDOR_SPECS[vendor].efforts];
    const out: Record<string, string[]> = {};
    for (const model of modelChoices(vendor)) {
      for (const effort of efforts) out[`${show(model)} × ${show(effort)}`] = agentLaunchArgs({ vendor, model, effort });
    }
    expect(portable(out)).toMatchSnapshot();
  });
});

describe("迁移前快照：提示词（每家 × 项目经理、Worker）", () => {
  it.each(AGENT_VENDORS)("%s 的项目经理", (vendor) => {
    const base = projectContext();
    const prompt = buildLaunchPrompt({ ...base, pm: { ...base.pm, vendor } }, CWD);
    expect(portable(prompt)).toMatchSnapshot();
  });

  it.each(AGENT_VENDORS)("%s 的 Worker", (vendor) => {
    const prompt = buildWorkerPrompt({ ...workerContext(), vendor }, CWD);
    expect(portable(prompt)).toMatchSnapshot();
  });
});
