import { validateAskOptions } from "../shared/domain.ts";
import { ROUTER_OPTION_MAX_COUNT } from "../shared/limits.ts";
import type { RouterReportLink } from "../shared/router.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { UsageError, type Parsed, type GroupArgs, fileArgsOf, allowOnly, expectPositionals, idOf, workerIdOf } from "./args.ts";

const hub = HUB_COMMAND;

export function parseRouterCommand({ group, action, rest, values, env, cwd }: GroupArgs): Parsed | undefined {
  if (group === "router" && action === "ask") {
    allowOnly(values, ["question", "option", "recommended", "replace", "context", "stdin"], "router ask");
    expectPositionals(rest, 0, "router ask");
    if (values.question === undefined || values.question.trim() === "") {
      throw new UsageError(`${hub} router ask 要 --question <问题>`);
    }
    if (values.option === undefined) {
      throw new UsageError(`${hub} router ask 要 --option <选项>（2 到 ${ROUTER_OPTION_MAX_COUNT} 个）`);
    }
    const checked = validateAskOptions(values.option);
    if (!checked.ok) throw new UsageError(checked.error);
    if (checked.options.length > ROUTER_OPTION_MAX_COUNT) {
      throw new UsageError(`选项最多 ${ROUTER_OPTION_MAX_COUNT} 个`);
    }
    const options = [...checked.options];
    const body: Record<string, unknown> = { options };
    if (values.recommended !== undefined) {
      const rec = values.recommended.trim();
      let idx = -1;
      if (/^[1-9][0-9]*$/.test(rec)) {
        const oneBased = Number(rec);
        if (oneBased >= 1 && oneBased <= options.length) idx = oneBased - 1;
      } else {
        idx = options.indexOf(rec);
      }
      if (idx < 0) throw new UsageError(`--recommended 要写 1 到 ${options.length} 或某个选项原文`);
      body.recommended = options[idx]!;
    }
    if (values.stdin === true && values.context !== undefined) {
      throw new UsageError("--stdin 和 --context 只能用一个");
    }
    const question = values.question.trim();
    if (values.replace !== undefined) body.replaceItemId = idOf(values.replace, "router ask", "卡片");
    if (values.stdin === true) {
      body.text = question;
      return {
        command: "ask",
        body,
        textSource: { kind: "stdin" },
        textField: "text",
        textOptional: true,
        textPrefix: `${question}\n`,
      };
    }
    const ctxText = values.context?.trim() ?? "";
    body.text = ctxText === "" ? question : `${question}\n\n${ctxText}`;
    return { command: "ask", body, textSource: null };
  }
  if (group === "router" && action === "report") {
    allowOnly(values, ["summary", "pr", "worker", "file", "link", "stdin"], "router report");
    expectPositionals(rest, 0, "router report");
    if (values.summary === undefined && values.stdin !== true) {
      throw new UsageError(`${hub} router report 要 --summary <摘要> 或 --stdin`);
    }
    if (values.summary !== undefined && values.summary.trim() === "") {
      throw new UsageError("--summary 不能是空的");
    }
    const links: RouterReportLink[] = [];
    if (values.pr !== undefined) {
      const prUrl = values.pr.trim();
      if (prUrl === "") throw new UsageError("--pr 不能是空的");
      const prNum = /\/pull\/([1-9][0-9]*)(?:$|[/?#])/.exec(prUrl)?.[1];
      links.push({ label: prNum !== undefined ? `PR #${prNum}` : "PR", target: prUrl });
    }
    if (values.worker !== undefined) {
      const wid = workerIdOf(values.worker, "router report");
      links.push({ label: `Worker #${wid}`, target: `worker:${wid}` });
    }
    if (values.link !== undefined) {
      for (const rawLink of values.link) {
        const eq = rawLink.indexOf("=");
        if (eq <= 0 || eq === rawLink.length - 1) throw new UsageError("--link 要写成 标签=地址");
        const label = rawLink.slice(0, eq).trim();
        const target = rawLink.slice(eq + 1).trim();
        if (label === "" || target === "") throw new UsageError("--link 要写成 标签=地址");
        links.push({ label, target });
      }
    }
    const body: Record<string, unknown> = {};
    if (links.length > 0) body.links = links;
    const files = fileArgsOf(values.file, env, cwd);
    if (files !== undefined) body.files = files;
    if (values.stdin === true) {
      return {
        command: "router.report",
        body,
        textSource: { kind: "stdin" },
        textField: "summary",
        ...(values.summary !== undefined ? { textPrefix: values.summary.trim() } : {}),
      };
    }
    body.summary = values.summary!.trim();
    return { command: "router.report", body, textSource: null };
  }
  return undefined;
}
