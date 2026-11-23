import { PM_MODES } from "../shared/domain.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { AGENT_VENDORS, isAgentVendor } from "../shared/vendors.ts";
import {
  UsageError,
  type Parsed,
  type GroupArgs,
  expandPath,
  allowOnly,
  expectPositionals,
  idOf,
  workerIdOf,
  effortOf,
  requireDevice,
  requireVerbatimOrStdin,
} from "./args.ts";

const hub = HUB_COMMAND;

export function parseDispatchPmCommand({ group, action, rest, values }: GroupArgs): Parsed | undefined {
  if (group !== "dispatch") return undefined;
  if (action === "pm") {
    allowOnly(values, ["device", "pm", "project", "verbatim", "stdin"], "dispatch pm");
    expectPositionals(rest, 0, "dispatch pm");
    const device = requireDevice(values, "dispatch pm");
    if (values.pm === undefined && values.project === undefined) {
      throw new UsageError(`${hub} dispatch pm 要 --pm <pmId>（或 --project <projectId>）`);
    }
    const verbatim = requireVerbatimOrStdin(values, "dispatch pm");
    const body: Record<string, unknown> = { op: "pm", device };
    if (values.pm !== undefined) body.pmId = idOf(values.pm, "dispatch pm", "项目经理");
    if (values.project !== undefined) body.projectId = idOf(values.project, "dispatch pm", "项目");
    if (verbatim) {
      body.verbatim = true;
      return { command: "router.dispatch", body, textSource: null };
    }
    return { command: "router.dispatch", body, textSource: { kind: "stdin" }, textField: "text" };
  }
  if (action === "worker-start") {
    allowOnly(
      values,
      ["device", "project", "title", "vendor", "model", "effort", "readonly", "no-worktree", "verbatim", "stdin"],
      "dispatch worker-start",
    );
    expectPositionals(rest, 0, "dispatch worker-start");
    const device = requireDevice(values, "dispatch worker-start");
    if (values.project === undefined) throw new UsageError(`${hub} dispatch worker-start 要 --project <projectId>`);
    const projectId = idOf(values.project, "dispatch worker-start", "项目");
    const title = values.title?.trim() ?? "";
    if (title === "") throw new UsageError(`${hub} dispatch worker-start 要 --title <标题>`);
    if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
      throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
    }
    const normalizedEffort = effortOf(values.vendor, values.effort);
    const verbatim = requireVerbatimOrStdin(values, "dispatch worker-start");
    const body: Record<string, unknown> = { op: "worker-start", device, projectId, title };
    if (values.vendor !== undefined) body.vendor = values.vendor;
    if (values.model !== undefined) body.model = values.model;
    if (normalizedEffort !== undefined) body.effort = normalizedEffort;
    if (values.readonly === true) body.readonly = true;
    if (values["no-worktree"] === true) body.noWorktree = true;
    if (verbatim) {
      body.verbatim = true;
      return { command: "router.dispatch", body, textSource: null };
    }
    return { command: "router.dispatch", body, textSource: { kind: "stdin" }, textField: "task" };
  }
  return undefined;
}

export function parseDispatchWorkerCommand({ group, action, rest, values, env, cwd }: GroupArgs): Parsed | undefined {
  if (group !== "dispatch") return undefined;
  if (action === "worker-stop") {
    allowOnly(values, ["device", "worker"], "dispatch worker-stop");
    expectPositionals(rest, 0, "dispatch worker-stop");
    const device = requireDevice(values, "dispatch worker-stop");
    const workerId = workerIdOf(values.worker, "dispatch worker-stop");
    return { command: "router.dispatch", body: { op: "worker-stop", device, workerId }, textSource: null };
  }
  if (action === "worker-send") {
    allowOnly(values, ["device", "worker", "verbatim", "stdin"], "dispatch worker-send");
    expectPositionals(rest, 0, "dispatch worker-send");
    const device = requireDevice(values, "dispatch worker-send");
    const workerId = workerIdOf(values.worker, "dispatch worker-send");
    const verbatim = requireVerbatimOrStdin(values, "dispatch worker-send");
    const body: Record<string, unknown> = { op: "worker-send", device, workerId };
    if (verbatim) {
      body.verbatim = true;
      return { command: "router.dispatch", body, textSource: null };
    }
    return { command: "router.dispatch", body, textSource: { kind: "stdin" }, textField: "text" };
  }
  if (action === "worker-end") {
    allowOnly(values, ["device", "worker"], "dispatch worker-end");
    expectPositionals(rest, 0, "dispatch worker-end");
    const device = requireDevice(values, "dispatch worker-end");
    const workerId = workerIdOf(values.worker, "dispatch worker-end");
    return { command: "router.dispatch", body: { op: "worker-end", device, workerId }, textSource: null };
  }
  if (action === "worker-list") {
    allowOnly(values, ["device", "project"], "dispatch worker-list");
    expectPositionals(rest, 0, "dispatch worker-list");
    const device = requireDevice(values, "dispatch worker-list");
    const body: Record<string, unknown> = { op: "worker-list", device };
    if (values.project !== undefined) body.projectId = idOf(values.project, "dispatch worker-list", "项目");
    return { command: "router.dispatch", body, textSource: null };
  }
  if (action === "project-show") {
    allowOnly(values, ["device", "project"], "dispatch project-show");
    expectPositionals(rest, 0, "dispatch project-show");
    const device = requireDevice(values, "dispatch project-show");
    if (values.project === undefined) throw new UsageError(`${hub} dispatch project-show 要 --project <projectId>`);
    const projectId = idOf(values.project, "dispatch project-show", "项目");
    return { command: "router.dispatch", body: { op: "project-show", device, projectId }, textSource: null };
  }
  if (action === "project-create") {
    allowOnly(values, ["device", "folder", "name", "pm-name", "vendor", "mode"], "dispatch project-create");
    expectPositionals(rest, 0, "dispatch project-create");
    const device = requireDevice(values, "dispatch project-create");
    if (values.folder === undefined || values.folder.trim() === "") {
      throw new UsageError(`${hub} dispatch project-create 要 --folder <路径>`);
    }
    if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
      throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
    }
    if (values.mode !== undefined && !(PM_MODES as readonly string[]).includes(values.mode)) {
      throw new UsageError(`--mode 只能是 ${PM_MODES.join(" 或 ")}`);
    }
    const rawFolder = values.folder.trim();
    let folder: string;
    if (device === "self") {
      folder = expandPath(rawFolder, env, cwd);
    } else {
      const isWinAbs = /^[A-Za-z]:[\\/]/.test(rawFolder) || rawFolder.startsWith("\\\\");
      if (!rawFolder.startsWith("/") && !isWinAbs && rawFolder !== "~" && !rawFolder.startsWith("~/") && !rawFolder.startsWith("~\\")) {
        throw new UsageError("远端设备 --folder 要写绝对路径或 ~/...");
      }
      folder = rawFolder;
    }
    const body: Record<string, unknown> = { op: "project-create", device, folder };
    if (values.name !== undefined) body.name = values.name;
    if (values["pm-name"] !== undefined) body.pmName = values["pm-name"];
    if (values.vendor !== undefined) body.vendor = values.vendor;
    if (values.mode !== undefined) body.mode = values.mode;
    return { command: "router.dispatch", body, textSource: null };
  }
  return undefined;
}
