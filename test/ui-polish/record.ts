// 每轮的记录（docs/ui-polish-loop-design.md 第 3.7 节）：进仓库的是每轮一份 JSON 和一张总表；图不进仓库（同一个提交重截出来字节一样，记录里留了提交号和每张图的 sha256）。
// 不变量：一轮的记录写下去就不改；要更正就写下一轮。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { PASS_SCORE, RECORD_DIR, VIEWPORTS, type ViewportName } from "./limits.ts";
import { DIMENSIONS, DIMENSION_TITLES } from "./rubric.ts";
import { AREA_TITLES, SCREEN_AREAS, SCREEN_INVENTORY, expandShots, type ScreenArea } from "./screens.ts";
import type { CalibrationReport, MergedFinding, NextStep, ShotScore } from "./score.ts";

/** 归因分出来的一组修改：同一个根因的发现一起修、一个提交。 */
export interface FixGroup {
  id: string;
  /** 根因在哪一层，修的顺序也是这个顺序。 */
  layer: "standard" | "shared-component" | "screen";
  title: string;
  /** 这一组要消掉的发现：`<图的 key>#<规则>`。 */
  findings: readonly string[];
  /** 修改的提交号，没修（留到下一轮或列给用户）是 null。 */
  commit: string | null;
  /** 下一次评审后填：留下了还是撤回了，撤回写原因。 */
  outcome: { kept: true } | { kept: false; reason: string } | null;
}

export interface RoundRecord {
  /** `C1`、`C2` 是校准，`R01` 起是评审；确认评审在同一轮后面加 `-confirm`。 */
  id: string;
  kind: "calibration" | "review" | "confirm";
  /** 截图的提交和浏览器版本。 */
  commit: string;
  browser: string;
  /** 完成时间，ISO 8601。 */
  finishedAt: string;
  judges: readonly string[];
  /** 每张图的 sha256 和分数。 */
  shots: ReadonlyArray<ShotScore & { sha256: string }>;
  findings: readonly MergedFinding[];
  /** 这次评审之后定的修改分组（review 才有）。 */
  fixGroups: readonly FixGroup[];
  /** 修改所在的 PR。 */
  pr: string | null;
  next: NextStep | null;
  /** 校准才有。 */
  calibration: CalibrationReport | null;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function isRoundRecordShape(value: unknown): value is RoundRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.kind === "calibration" || v.kind === "review" || v.kind === "confirm") &&
    typeof v.commit === "string" &&
    typeof v.browser === "string" &&
    typeof v.finishedAt === "string" &&
    Array.isArray(v.judges) &&
    Array.isArray(v.shots) &&
    Array.isArray(v.findings) &&
    Array.isArray(v.fixGroups)
  );
}

function readOrderFromIndex(indexPath: string): string[] {
  if (!existsSync(indexPath)) return [];
  const text = readFileSync(indexPath, "utf8");
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\|\s*([A-Za-z0-9-]+)\s*\|/.exec(line);
    if (match !== null && match[1] !== "轮次" && match[1] !== "---") {
      ids.push(match[1]!);
    }
  }
  return ids;
}

/**
 * 后置：写成 `<repoRoot>/docs/ui-polish/rounds/<id>.json`，并重写总表 `docs/ui-polish/rounds.md`，返回 JSON 的路径。
 * 这个 id 已经有记录抛 Error，不覆盖。
 */
export function writeRoundRecord(repoRoot: string, record: RoundRecord): string {
  const baseDir = join(repoRoot, RECORD_DIR);
  const roundsDir = join(baseDir, "rounds");
  mkdirSync(roundsDir, { recursive: true });
  const jsonPath = join(roundsDir, `${record.id}.json`);
  if (existsSync(jsonPath)) {
    throw new Error(`轮次记录 ${record.id} 已存在：${jsonPath}`);
  }
  const existing = readRoundRecords(repoRoot);
  const updated = [...existing, record];
  writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(baseDir, "rounds.md"), roundsIndexMarkdown(updated));
  return jsonPath;
}

/** 全部记录，按写入的先后。读不出来的文件抛 Error 并说出文件名。 */
export function readRoundRecords(repoRoot: string): RoundRecord[] {
  const baseDir = join(repoRoot, RECORD_DIR);
  const roundsDir = join(baseDir, "rounds");
  if (!existsSync(roundsDir)) return [];

  const entries = readdirSync(roundsDir).filter((name) => name.endsWith(".json"));
  const loaded: Array<{ record: RoundRecord; mtimeMs: number; fileName: string }> = [];

  for (const fileName of entries) {
    const fullPath = join(roundsDir, fileName);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fullPath, "utf8"));
    } catch (error) {
      throw new Error(`读取轮次记录 ${fileName} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRoundRecordShape(parsed)) {
      throw new Error(`轮次记录 ${fileName} 格式不合法`);
    }
    loaded.push({ record: parsed, mtimeMs: statSync(fullPath).mtimeMs, fileName });
  }

  const order = readOrderFromIndex(join(baseDir, "rounds.md"));
  const rankOf = (id: string) => {
    const idx = order.indexOf(id);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  loaded.sort((a, b) => {
    const ra = rankOf(a.record.id);
    const rb = rankOf(b.record.id);
    if (ra !== rb) return ra - rb;
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    if (a.record.finishedAt !== b.record.finishedAt) return a.record.finishedAt.localeCompare(b.record.finishedAt);
    return a.fileName.localeCompare(b.fileName);
  });

  return loaded.map((item) => item.record);
}

function formatNext(next: NextStep | null): string {
  if (next === null) return "—";
  if (next.action === "ask-user") return `ask-user (${next.why})`;
  return next.action;
}

/** 总表（Markdown）：一轮一行，写提交、评委、不达标的图数、最低分、中位分、修了几组留了几组、PR；最后一节是每张图各轮的页面分。 */
export function roundsIndexMarkdown(records: readonly RoundRecord[]): string {
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const lines = [
    "# 界面打磨轮次总表",
    "",
    "## 轮次总览",
    "",
    "| 轮次 | 类型 | 提交 | 评委 | 不达标图数 | 最低分 | 中位分 | 修改组 | 下一步 | PR |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const r of records) {
    const pages = r.shots.map((s) => s.page);
    const belowCount = r.shots.filter((s) => s.page < PASS_SCORE).length;
    const minScore = pages.length === 0 ? "—" : String(Math.min(...pages));
    const medScore = pages.length === 0 ? "—" : String(median(pages));
    const kept = r.fixGroups.filter((g) => g.outcome?.kept === true).length;
    const reverted = r.fixGroups.filter((g) => g.outcome?.kept === false).length;
    const groupSummary = r.fixGroups.length === 0 ? "—" : `修 ${r.fixGroups.length} / 留 ${kept} / 撤 ${reverted}`;
    const judgesText = r.judges.length === 0 ? "—" : cell(r.judges.join("、"));
    const prText = r.pr ?? "—";
    lines.push(
      `| ${cell(r.id)} | ${r.kind} | \`${r.commit.slice(0, 8)}\` | ${judgesText} | ${belowCount} | ${minScore} | ${medScore} | ${groupSummary} | ${formatNext(r.next)} | ${cell(prText)} |`,
    );
  }

  lines.push("", "## 每张图各轮页面分", "");
  if (records.length === 0) {
    lines.push("暂无记录。");
    return `${lines.join("\n")}\n`;
  }

  const canonicalOrder = expandShots(SCREEN_INVENTORY).map((s) => s.key);
  const seenKeys = new Set<string>();
  for (const r of records) {
    for (const s of r.shots) seenKeys.add(s.shotKey);
  }
  const sortedKeys = [
    ...canonicalOrder.filter((k) => seenKeys.has(k)),
    ...[...seenKeys].filter((k) => !canonicalOrder.includes(k)).sort(),
  ];

  lines.push(`| 界面 | ${records.map((r) => cell(r.id)).join(" | ")} |`);
  lines.push(`| --- | ${records.map(() => "---").join(" | ")} |`);

  const maps = records.map((r) => new Map(r.shots.map((s) => [s.shotKey, s.page])));
  for (const key of sortedKeys) {
    const rowScores = maps.map((m) => {
      const v = m.get(key);
      return v === undefined ? "—" : String(v);
    });
    lines.push(`| \`${cell(key)}\` | ${rowScores.join(" | ")} |`);
  }

  return `${lines.join("\n")}\n`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toRelativePosix(fromDir: string, toDir: string, fileName: string): string {
  const relDir = relative(fromDir, toDir).replaceAll("\\", "/");
  return relDir === "" ? fileName : posix.join(relDir, fileName);
}

function areaOfShotKey(shotKey: string): ScreenArea | "other" {
  const baseId = shotKey.split("!")[0]!.split("@")[0]!;
  const found = SCREEN_AREAS.find((a) => baseId.startsWith(`${a}.`));
  return found ?? "other";
}

const STATE_LABELS: Record<string, string> = {
  empty: "空",
  loading: "加载中",
  error: "出错",
  long: "超长",
  busy: "在忙",
};

function pct(n: number): string {
  return `${Math.round(n * 10_000) / 100}%`;
}

/**
 * 给用户看的一页（HTML，单文件）：每张图的整屏图、发现的框和文字、两家的分数；给了 previous 时并排放上一轮的图和分数变化。
 * 图用相对路径引 shotsDir 里的文件。
 */
export function reportHtml(input: { record: RoundRecord; shotsDir: string; previous?: { record: RoundRecord; shotsDir: string } }): string {
  const { record, shotsDir, previous } = input;
  const hasScores = record.judges.length > 0;
  const specMap = new Map(SCREEN_INVENTORY.map((s) => [s.id, s]));
  const prevShotMap = new Map(previous?.record.shots.map((s) => [s.shotKey, s]) ?? []);

  const findingsByShot = new Map<string, MergedFinding[]>();
  for (const f of record.findings) {
    if (!f.counted) continue;
    const list = findingsByShot.get(f.shotKey) ?? [];
    list.push(f);
    findingsByShot.set(f.shotKey, list);
  }

  const groups = new Map<ScreenArea | "other", Array<ShotScore & { sha256: string }>>();
  for (const area of SCREEN_AREAS) groups.set(area, []);
  groups.set("other", []);
  for (const s of record.shots) {
    const area = areaOfShotKey(s.shotKey);
    groups.get(area)!.push(s);
  }

  const activeGroups = [...groups.entries()].filter(([, list]) => list.length > 0);
  const passCount = record.shots.filter((s) => s.page >= PASS_SCORE).length;

  const navItems = activeGroups
    .map(([area, list]) => {
      const title = area === "other" ? "其他" : AREA_TITLES[area];
      return `<a class="nav-pill" href="#area-${escapeHtml(area)}">${escapeHtml(title)} <span class="num">${list.length}</span></a>`;
    })
    .join("");

  let shotSequence = 0;
  const sectionsHtml = activeGroups
    .map(([area, list]) => {
      const areaTitle = area === "other" ? "其他" : AREA_TITLES[area];
      const cardsHtml = list
        .map((shot) => {
          const seq = shotSequence++;
          const lazyAttr = seq < 6 ? "" : ' loading="lazy"';
          const baseKey = shot.shotKey.split("!")[0]!;
          const screenId = baseKey.split("@")[0]!;
          const viewport = baseKey.split("@")[1] ?? "";
          const spec = specMap.get(screenId);
          const title = spec ? spec.title : shot.shotKey;
          const stateLabel = spec && spec.state !== "normal" ? STATE_LABELS[spec.state] : undefined;
          const isNarrowStage = viewport === "mobile" || viewport === "slim";
          const wellClass = isNarrowStage ? "stage-well stage-well-padded" : "stage-well";
          const imgSrc = escapeHtml(toRelativePosix(shotsDir, shotsDir, `${shot.shotKey}.png`));
          const focusExists = spec?.focus !== undefined && existsSync(join(shotsDir, `${shot.shotKey}.focus.png`));
          const focusSrc = focusExists ? escapeHtml(toRelativePosix(shotsDir, shotsDir, `${shot.shotKey}.focus.png`)) : null;

          const counted = findingsByShot.get(shot.shotKey) ?? [];
          const overlays = hasScores
            ? counted
                .map(
                  (f, idx) =>
                    `<div class="box box-${escapeHtml(f.severity.toLowerCase())}" style="left: ${pct(f.box.x)}; top: ${pct(f.box.y)}; width: ${pct(f.box.w)}; height: ${pct(f.box.h)};"><span class="box-tag">${idx + 1}</span></div>`,
                )
                .join("")
            : "";

          const prevShot = prevShotMap.get(shot.shotKey);
          const prevImgSrc =
            previous !== undefined ? escapeHtml(toRelativePosix(shotsDir, previous.shotsDir, `${shot.shotKey}.png`)) : null;

          let scoreHead = "";
          if (hasScores) {
            const deltaText =
              prevShot !== undefined && previous!.record.judges.length > 0
                ? `${prevShot.page} → ${shot.page}`
                : `${shot.page}`;
            const badgeClass = shot.page >= PASS_SCORE ? "score-pass" : "score-below";
            const dimSummary = DIMENSIONS.map((d) => `${DIMENSION_TITLES[d]} ${shot.dimensions[d]}`).join("  ");
            const judgeSummary = record.judges
              .map((j) => {
                const js = shot.byJudge[j];
                if (js === undefined) return "";
                const jp = Math.min(js.style, js.standard, js.aesthetic, js.ux);
                return `<span class="judge-chip">${escapeHtml(j)} <strong class="num">${jp}</strong>（${DIMENSIONS.map((d) => js[d]).join("/")}）</span>`;
              })
              .filter(Boolean)
              .join("");

            scoreHead = `<div class="score-bar">
              <span class="page-badge ${badgeClass} num">${escapeHtml(deltaText)}</span>
              <span class="dim-list num">${escapeHtml(dimSummary)}</span>
              <div class="judge-list">${judgeSummary}</div>
            </div>`;
          }

          const vpDims = viewport in VIEWPORTS ? VIEWPORTS[viewport as ViewportName] : undefined;
          const sizeAttr = vpDims ? ` width="${vpDims.width}" height="${vpDims.height}"` : "";
          const stageMod =
            viewport === "mobile" ? " stage-mobile" : viewport === "slim" ? " stage-slim" : "";
          const figureHtml =
            prevImgSrc !== null
              ? `<div class="compare-grid">
                  <div class="compare-col">
                    <div class="col-label">${escapeHtml(previous!.record.id)}</div>
                    <div class="${wellClass}"><div class="shot-stage${stageMod}"><img src="${prevImgSrc}" alt="${escapeHtml(shot.shotKey)}"${sizeAttr}${lazyAttr} /></div></div>
                  </div>
                  <div class="compare-col">
                    <div class="col-label">${escapeHtml(record.id)}</div>
                    <div class="${wellClass}"><div class="shot-stage${stageMod}"><img src="${imgSrc}" alt="${escapeHtml(shot.shotKey)}"${sizeAttr}${lazyAttr} />${overlays}</div></div>
                  </div>
                </div>`
              : `<div class="${wellClass}"><div class="shot-stage${stageMod}"><img src="${imgSrc}" alt="${escapeHtml(shot.shotKey)}"${sizeAttr}${lazyAttr} />${overlays}</div></div>`;

          const focusHtml =
            focusSrc !== null
              ? `<div class="focus-row"><span class="meta-tag">局部 2x：${escapeHtml(spec?.focus ?? "")}</span><img class="focus-img" src="${focusSrc}" alt="${escapeHtml(shot.shotKey)} focus"${lazyAttr} /></div>`
              : "";

          const findingsHtml =
            hasScores && counted.length > 0
              ? `<ul class="finding-list">${counted
                  .map(
                    (f, idx) =>
                      `<li class="finding-row">
                        <span class="sev sev-${escapeHtml(f.severity.toLowerCase())}">${idx + 1} ${escapeHtml(f.severity)}</span>
                        <code class="rule-code">${escapeHtml(f.rule)}</code>
                        <span class="finding-what">${escapeHtml(f.what)}</span>
                        <span class="finding-fix">改法：${escapeHtml(f.fix)}</span>
                        <span class="finding-by">${escapeHtml(f.by.join("、"))}</span>
                      </li>`,
                  )
                  .join("")}</ul>`
              : "";

          return `<article class="shot-card" id="shot-${escapeHtml(shot.shotKey)}">
            <header class="card-head">
              <div class="title-group">
                <h3 class="card-title">${escapeHtml(title)}</h3>
                <code class="shot-key">${escapeHtml(shot.shotKey)}</code>
                ${stateLabel ? `<span class="state-tag">${escapeHtml(stateLabel)}</span>` : ""}
              </div>
              ${scoreHead}
            </header>
            ${figureHtml}
            ${focusHtml}
            ${findingsHtml}
          </article>`;
        })
        .join("\n");

      const gridClass = previous !== undefined || hasScores ? "cards-single" : "cards-grid";
      return `<section class="area-section" id="area-${escapeHtml(area)}">
        <div class="area-head">
          <h2 class="area-title">${escapeHtml(areaTitle)}</h2>
          <span class="area-count num">${list.length}</span>
        </div>
        <div class="${gridClass}">
          ${cardsHtml}
        </div>
      </section>`;
    })
    .join("\n");

  const statsSummary = hasScores
    ? `<span class="stat-item">达标 <strong class="num">${passCount}/${record.shots.length}</strong></span>
       <span class="stat-item">评委 ${escapeHtml(record.judges.join("、"))}</span>`
    : `<span class="stat-item">共 <strong class="num">${record.shots.length}</strong> 张截图</span>
       <span class="stat-item">${activeGroups.length} 个区域</span>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>界面总览 ${escapeHtml(record.id)}</title>
  <style>
    :root {
      --bg: #ffffff;
      --surface: #f6f6f7;
      --fg: #18181b;
      --muted: #71717a;
      --border: #ececef;
      --active: #e9e9ec;
      --danger: #d92d20;
      --caution: #dba10b;
      --success: #16a34a;
      --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      --font-code: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--surface);
      color: var(--fg);
      font-family: var(--font-ui);
      font-size: 15px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .num { font-variant-numeric: tabular-nums; }
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 20;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px 12px;
    }
    .top-row {
      max-width: 1440px;
      margin: 0 auto;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
    }
    .page-title {
      margin: 0;
      font-size: 17px;
      font-weight: 600;
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 13.5px;
      color: var(--muted);
    }
    .stats strong { color: var(--fg); font-weight: 600; }
    .nav-bar {
      max-width: 1440px;
      margin: 12px auto 0;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .nav-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 9999px;
      background: var(--surface);
      color: var(--fg);
      text-decoration: none;
      font-size: 13.5px;
      font-weight: 500;
    }
    .nav-pill:hover { background: var(--active); }
    .nav-pill .num { color: var(--muted); font-size: 12px; font-weight: 400; }
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 32px;
    }
    .area-section { scroll-margin-top: 112px; }
    .area-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 12px;
      padding: 0 4px;
    }
    .area-title {
      margin: 0;
      font-size: 17px;
      font-weight: 600;
    }
    .area-count {
      font-size: 12px;
      color: var(--muted);
    }
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
      gap: 20px;
    }
    .cards-single {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    @media (max-width: 960px) {
      .cards-grid { grid-template-columns: minmax(0, 1fr); }
    }
    .shot-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .card-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .title-group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .card-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }
    .shot-key, .rule-code {
      font-family: var(--font-code);
      font-size: 12px;
      background: var(--surface);
      padding: 2px 8px;
      border-radius: 9999px;
      color: var(--muted);
    }
    .meta-tag, .state-tag {
      font-size: 12px;
      color: var(--muted);
    }
    .state-tag {
      background: var(--surface);
      padding: 2px 8px;
      border-radius: 9999px;
    }
    .score-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      font-size: 13.5px;
    }
    .page-badge {
      padding: 2px 10px;
      border-radius: 9999px;
      font-weight: 600;
      color: #ffffff;
    }
    .score-pass { background: var(--success); }
    .score-below { background: var(--danger); }
    .dim-list { color: var(--muted); font-size: 12px; }
    .judge-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .judge-chip {
      font-size: 12px;
      color: var(--muted);
      background: var(--surface);
      padding: 2px 8px;
      border-radius: 9999px;
    }
    .judge-chip strong { color: var(--fg); }
    .compare-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .col-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .stage-well {
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .stage-well-padded {
      background: var(--surface);
      border-radius: 12px;
      padding: 12px;
    }
    .shot-stage {
      position: relative;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      background: var(--bg);
    }
    .cards-grid .shot-stage.stage-mobile { max-width: 196px; }
    .cards-single .shot-stage.stage-mobile { max-width: 300px; }
    .shot-stage.stage-slim { max-width: 360px; }
    .shot-stage img {
      display: block;
      width: 100%;
      height: auto;
    }
    .box {
      position: absolute;
      border: 2px solid var(--danger);
      pointer-events: none;
    }
    .box-p2 { border-color: var(--caution); }
    .box-p3 { border-color: var(--muted); }
    .box-tag {
      position: absolute;
      top: -1px;
      left: -1px;
      background: var(--danger);
      color: #ffffff;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      padding: 2px 5px;
    }
    .box-p2 .box-tag { background: var(--caution); }
    .box-p3 .box-tag { background: var(--muted); }
    .focus-row {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
    }
    .focus-img {
      max-width: 360px;
      max-height: 220px;
      width: auto;
      height: auto;
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .finding-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-top: 1px solid var(--border);
      padding-top: 12px;
    }
    .finding-row {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 8px;
      font-size: 13.5px;
    }
    .sev {
      font-size: 12px;
      font-weight: 600;
      padding: 1px 8px;
      border-radius: 9999px;
      color: #ffffff;
      background: var(--danger);
    }
    .sev-p2 { background: var(--caution); }
    .sev-p3 { background: var(--muted); }
    .finding-what { color: var(--fg); }
    .finding-fix, .finding-by { color: var(--muted); }
  </style>
</head>
<body>
  <header class="top-bar">
    <div class="top-row">
      <h1 class="page-title">${escapeHtml(record.id)} 界面总览</h1>
      <div class="stats">
        ${statsSummary}
        <span class="stat-item num">提交 ${escapeHtml(record.commit.slice(0, 8))}</span>
        <span class="stat-item">${escapeHtml(record.browser)}</span>
      </div>
    </div>
    <nav class="nav-bar" aria-label="区域导航">${navItems}</nav>
  </header>
  <main>
    ${sectionsHtml}
  </main>
</body>
</html>
`;
}
