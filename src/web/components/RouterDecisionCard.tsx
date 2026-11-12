// 水果刀 Router 工作台：内嵌单行补充框的三合一待决拍板卡（docs/ui-standard.md 第 21 条、docs/router-design.md 第 4.2 节）。
// 严格禁止聊天气泡与 · / | / / 拼接分隔符，元信息一律以 flex gap-2 排布。
import { ArrowUp } from "lucide-react";
import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import type { ConversationId } from "../../shared/index.ts";
import { cleanOptionLabel, recommendedIndexOf } from "../decision-actions.ts";
import { formatTime, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { FleetDecisionEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Avatar } from "./Avatar.tsx";
import { Markdown } from "./Markdown.tsx";
import { RowError } from "./SettingsList.tsx";

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

/**
 * 补充依据：`hub router ask` / `hub graph ask` 传来的是 Markdown（段落、编号、子列表、行内代码），用共用的 Markdown 渲染，
 * 13.5px 灰字紧凑排版（Markdown 的间距都是 em，跟着字号缩）。超过 5 行（行数在 styles.css 的 `.decision-context-clamp`）
 * 默认收起，底部渐隐，下面一个 `Show more` / `Show less`；没超过就整段显示，不出按钮。
 */
const DecisionContext = memo(function DecisionContext({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const id = useId();

  // 收起时量一次“内容比框高”：框宽变了（窗口、托盘滚动条）或正文变了都重新量；展开时保持上一次的结论，按钮留着好收回去。
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null || expanded) return;
    const measure = () => setOverflowing(box.scrollHeight > box.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild !== null) observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="mt-1">
      <div
        ref={boxRef}
        id={id}
        data-decision-context
        data-overflowing={overflowing && !expanded ? "" : undefined}
        className={cn("text-minor text-muted-foreground", !expanded && "decision-context-clamp")}
      >
        <Markdown text={text} />
      </div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          className="touch-target mt-1 inline-flex cursor-pointer items-center rounded-full text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
});

export interface RouterDecisionCardProps {
  entry: FleetDecisionEntry;
  multiDevice: boolean;
  busy: boolean;
  note: string;
  error: ErrorLike | null;
  onNoteChange: (key: string, value: string) => void;
  onSubmit: (entry: FleetDecisionEntry, optionIndex: number | null, note: string) => void;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
}

export const RouterDecisionCard = memo(function RouterDecisionCard({
  entry,
  multiDevice,
  busy,
  note,
  error,
  onNoteChange,
  onSubmit,
  onOpenConversation,
}: RouterDecisionCardProps) {
  const { decision, online } = entry;
  const recommendedIdx = recommendedIndexOf(decision);
  const disabled = !online || busy;
  const canSendCustom = !disabled && note.trim().length > 0;
  const showProject = decision.projectName !== null && decision.projectName !== decision.pmName;
  const showDevice = multiDevice || !entry.self;
  const blockedCount = decision.source.kind === "gate" ? decision.source.blockedNodeCount : 0;

  return (
    <article
      aria-label={decision.question}
      className={cn("rounded-2xl border border-border bg-background p-4 transition-opacity", !online && "opacity-60")}
    >
      <div className="flex flex-wrap items-center gap-2 text-minor">
        <button
          type="button"
          className="touch-target inline-flex cursor-pointer items-center gap-2 rounded-full text-left font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => onOpenConversation(entry.deviceKey, decision.conversationId)}
        >
          <Avatar colorKey={entry.avatarKey} size={24} />
          <span className="truncate">{decision.pmName}</span>
        </button>
        {showProject && <span className="truncate text-muted-foreground">{decision.projectName}</span>}
        {showDevice && <span className="truncate text-xs text-muted-foreground">{entry.deviceName}</span>}
        {!online && (
          <span className="rounded-full bg-sidebar px-2 py-0.5 text-xs font-medium text-muted-foreground">Offline</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatTime(decision.createdAt)}</span>
      </div>

      <h3 className="mt-2.5 text-body font-medium text-foreground">{decision.question}</h3>
      {decision.context.trim() !== "" && <DecisionContext key={decision.key} text={decision.context} />}
      {blockedCount > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {blockedCount === 1 ? "1 downstream step waiting" : `${blockedCount} downstream steps waiting`}
        </p>
      )}

      {decision.options.length > 0 && (
        <div className="mt-3 space-y-2">
          {decision.options.map((rawOption, idx) => {
            const label = cleanOptionLabel(rawOption);
            const isRecommended = idx === recommendedIdx;
            const letter = OPTION_LETTERS[idx] ?? String(idx + 1);
            return (
              <button
                key={`${decision.key}-opt-${idx}`}
                type="button"
                disabled={disabled}
                className="flex min-h-11 w-full cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5 text-left text-body leading-6 transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
                onClick={() => onSubmit(entry, idx, note)}
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-sidebar text-xs font-medium text-muted-foreground">
                  {letter}
                </span>
                {/* 宽的时候 Recommended 在右边和第一行对齐、离文字 16px；放不下 20rem 的文字时（手机）换到文字下面，不把选项挤成一条窄列 */}
                <span className="flex min-w-0 flex-1 flex-wrap items-start gap-x-4">
                  <span className="min-w-0 grow basis-80">{label}</span>
                  {isRecommended && <span className="shrink-0 text-xs leading-6 text-muted-foreground">Recommended</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <Input
          value={note}
          disabled={disabled}
          aria-label="Note or custom reply"
          placeholder="Add a note, or type a custom reply…"
          className="min-w-0 flex-1"
          onChange={(e) => onNoteChange(decision.key, e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            if (canSendCustom) onSubmit(entry, null, note);
          }}
        />
        <Button
          size="icon"
          aria-label="Send reply"
          disabled={!canSendCustom}
          onClick={() => onSubmit(entry, null, note)}
        >
          <ArrowUp className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {error && (
        <div className="mt-2">
          <RowError error={error} />
        </div>
      )}
    </article>
  );
});
