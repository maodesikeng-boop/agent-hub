// hub worker search、worker show --task / --report：项目经理的“档案记忆”，从账本里按需搜、按需读，不占上下文。
// - 范围：workers.pm_id 是自己的所有 Worker（含已收工的，和 hub worker list 一样）；搜 workers.title、workers.task、
//   项目经理对话里这个 Worker 的汇报（messages 里 kind worker、meta.event 是 report，text 去掉“【Worker … 的汇报】”那行开头就是汇报原文）；
// - 匹配：简单子串，关键词都要出现在同一处（标题、任务说明或某一轮汇报）；英文不分大小写，中文原样；数据量小，不建索引。
import type { HubArgs, HubResult, WorkerSearchHit } from "../../shared/hub.ts";
import {
  WORKER_SEARCH_CONTEXT_CHARS,
  WORKER_SEARCH_DEFAULT_LIMIT,
  WORKER_SEARCH_MAX_KEYWORDS,
  WORKER_SEARCH_MAX_KEYWORD_CHARS,
  WORKER_SEARCH_MAX_LIMIT,
} from "../../shared/limits.ts";
import { workerReportHeader } from "../../shared/worker.ts";
import { fail } from "./context.ts";
import type { LedgerContext } from "./context.ts";
import type { WorkerDbRow } from "./rows.ts";

interface ReportRow {
  id: number;
  text: string;
  created_at: number;
}

/** 汇报原文：去掉交给项目经理时加的开头。 */
export function reportBody(worker: Pick<WorkerDbRow, "id" | "title">, text: string): string {
  const head = `${workerReportHeader(worker.id, worker.title)}\n\n`;
  return text.startsWith(head) ? text.slice(head.length) : text;
}

/** 命中处前后各取一些字，连同关键词一共不超过 WORKER_SEARCH_CONTEXT_CHARS 个字；换行并成空格，被截掉的那头加省略号。 */
export function snippetOf(text: string, keywords: string[]): string {
  const chars = [...text.replace(/\s+/g, " ")];
  const lower = chars.map((c) => c.toLowerCase()).join("");
  // 以最靠前的那个关键词命中处为中心（lower 和 chars 逐字对应，除非个别字小写后变长，这时位置只会略偏）
  const first = keywords.map((k) => lower.indexOf(k)).filter((i) => i >= 0);
  const at = first.length === 0 ? 0 : Math.min(...first);
  const matchLen = Math.min([...keywords.find((k) => lower.indexOf(k) === at) ?? ""].length, WORKER_SEARCH_CONTEXT_CHARS);
  const startChar = [...lower.slice(0, at)].length;
  const room = WORKER_SEARCH_CONTEXT_CHARS - matchLen;
  let from = Math.max(0, startChar - Math.floor(room / 2));
  const to = Math.min(chars.length, from + WORKER_SEARCH_CONTEXT_CHARS);
  from = Math.max(0, to - WORKER_SEARCH_CONTEXT_CHARS);
  return `${from > 0 ? "…" : ""}${chars.slice(from, to).join("").trim()}${to < chars.length ? "…" : ""}`;
}

export function createLedgerWorkerSearch(ctx: LedgerContext) {
  const { db } = ctx;

  const reportsOf = (workerId: number): ReportRow[] =>
    db.all<ReportRow>(
      `SELECT id, text, created_at FROM messages WHERE worker_id = ? AND kind = 'worker' AND json_extract(meta, '$.event') = 'report' ORDER BY id`,
      workerId,
    );

  /** hub worker show --report [N]：第 N 轮汇报原文（和 search 里的“汇报 #N”一致，从 1 起、从旧到新）；"latest" 是最新一轮。 */
  const reportText = (worker: WorkerDbRow, n: number | "latest"): string => {
    if (n !== "latest" && (!Number.isSafeInteger(n) || n < 1)) throw fail("invalid", "--report 的 N 要写正整数（第几轮汇报，和 search 里的“汇报 #N”一致）");
    const reports = reportsOf(worker.id);
    if (reports.length === 0) throw fail("invalid", `Worker #${worker.id}“${worker.title}”还没有汇报过`);
    const row = reports[n === "latest" ? reports.length - 1 : n - 1];
    if (row === undefined) throw fail("invalid", `Worker #${worker.id}“${worker.title}”只汇报过 ${reports.length} 次，没有第 ${n} 轮`);
    return reportBody(worker, row.text);
  };

  const search = (caller: { pmId: number }, args: HubArgs<"worker.search">): HubResult<"worker.search"> => {
    const { keywords, limit = WORKER_SEARCH_DEFAULT_LIMIT } = args;
    if (!Array.isArray(keywords) || keywords.length === 0 || keywords.some((k) => typeof k !== "string" || k.trim() === "")) {
      throw fail("invalid", "要至少一个关键词，且不能是空的");
    }
    if (keywords.length > WORKER_SEARCH_MAX_KEYWORDS) throw fail("invalid", `关键词最多 ${WORKER_SEARCH_MAX_KEYWORDS} 个`);
    if (keywords.some((k) => [...k].length > WORKER_SEARCH_MAX_KEYWORD_CHARS)) {
      throw fail("invalid", `每个关键词最多 ${WORKER_SEARCH_MAX_KEYWORD_CHARS} 个字符`);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKER_SEARCH_MAX_LIMIT) {
      throw fail("invalid", `--limit 要写 1 到 ${WORKER_SEARCH_MAX_LIMIT} 之间的整数`);
    }
    const words = keywords.map((k) => k.trim().toLowerCase());
    const matches = (text: string) => {
      const lower = text.toLowerCase();
      return words.every((w) => lower.includes(w));
    };

    const rows = db.all<WorkerDbRow>("SELECT * FROM workers WHERE pm_id = ? ORDER BY id", caller.pmId);
    const reportsByWorker = new Map<number, ReportRow[]>();
    if (rows.length > 0) {
      for (const r of db.all<ReportRow & { worker_id: number }>(
        `SELECT m.worker_id, m.id, m.text, m.created_at FROM messages m
         JOIN workers w ON w.id = m.worker_id
         WHERE w.pm_id = ? AND m.kind = 'worker' AND json_extract(m.meta, '$.event') = 'report'
         ORDER BY m.id`,
        caller.pmId,
      )) {
        let list = reportsByWorker.get(r.worker_id);
        if (list === undefined) {
          list = [];
          reportsByWorker.set(r.worker_id, list);
        }
        list.push(r);
      }
    }

    const found: Array<{ at: number; order: number; hit: WorkerSearchHit }> = [];
    for (const w of rows) {
      const base = { workerId: w.id, title: w.title, status: w.status === "ended" ? "已收工" : "进行中" };
      if (matches(w.title)) found.push({ at: w.created_at, order: 0, hit: { ...base, where: "title", snippet: snippetOf(w.title, words) } });
      if (matches(w.task)) found.push({ at: w.created_at, order: 1, hit: { ...base, where: "task", snippet: snippetOf(w.task, words) } });
      (reportsByWorker.get(w.id) ?? []).forEach((r, i) => {
        const body = reportBody(w, r.text);
        if (matches(body)) found.push({ at: r.created_at, order: 2 + i, hit: { ...base, where: "report", report: i + 1, snippet: snippetOf(body, words) } });
      });
    }
    // 最新的在前：时间倒序，同一时刻的后出现的在前
    found.sort((a, b) => b.at - a.at || b.hit.workerId - a.hit.workerId || b.order - a.order);
    const hits = found.slice(0, limit).map((f) => f.hit);
    const label = keywords.map((k) => `“${k}”`).join(" ");
    if (hits.length === 0) return { text: `没有搜到同时包含 ${label} 的 Worker 标题、任务说明或汇报。`, data: { hits } };
    const lines = hits.map((h) => {
      const where = h.where === "title" ? "标题" : h.where === "task" ? "任务" : `汇报 #${h.report}`;
      return `#${h.workerId}“${h.title}” · ${h.status} · ${where}：${h.snippet}`;
    });
    const more = found.length > hits.length ? `（还有 ${found.length - hits.length} 处没列，用 --limit 调大，最多 ${WORKER_SEARCH_MAX_LIMIT}）` : "";
    return { text: `搜到 ${found.length} 处包含 ${label}，最新的在前${more}：\n${lines.join("\n")}`, data: { hits } };
  };

  return { search, reportText };
}
