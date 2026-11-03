import { Plus } from "lucide-react";
import { formatTime } from "../format.ts";
import { stripMarkdown } from "../plainText.ts";
import type { ConversationEntry } from "../selectors.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { EntryAvatar } from "./Avatar.tsx";

/** agent 的消息是 Markdown，预览去掉符号；用户和系统消息本来就是纯文本。 */
function previewText(entry: ConversationEntry): string {
  const last = entry.lastMessage;
  if (!last) return "";
  return last.sender === "agent" ? stripMarkdown(last.text) : last.text;
}

function EntryButton({ entry, active, onSelect }: { entry: ConversationEntry; active: boolean; onSelect: (id: number) => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "bg-sidebar-active" : "hover:bg-sidebar-hover",
      )}
      onClick={() => onSelect(entry.id)}
    >
      <EntryAvatar kind={entry.kind} name={entry.name} colorKey={entry.avatarKey} size={44} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-[15px]", active ? "font-semibold" : "font-medium")}>{entry.name}</span>
          {entry.lastMessage && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatTime(entry.lastMessage.createdAt)}</span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[13.5px] text-muted-foreground">{previewText(entry)}</span>
      </span>
    </button>
  );
}

function Group({
  label,
  entries,
  activeId,
  onSelect,
}: {
  label: string;
  entries: ConversationEntry[];
  activeId: number | null;
  onSelect: (id: number) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section aria-label={label} className="space-y-1">
      <h2 className="px-3 pt-3 pb-1 text-[13px] font-medium text-muted-foreground">{label}</h2>
      {entries.map((entry) => (
        <EntryButton key={entry.id} entry={entry} active={entry.id === activeId} onSelect={onSelect} />
      ))}
    </section>
  );
}

export function Sidebar({
  entries,
  activeId,
  onSelect,
  onNewPm,
  onNewProject,
}: {
  /** 已经按最后一条消息的时间排好。 */
  entries: ConversationEntry[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onNewPm: () => void;
  onNewProject: () => void;
}) {
  const groups = entries.filter((e) => e.kind === "project_group");
  const direct = entries.filter((e) => e.kind !== "project_group");
  return (
    <aside className="flex w-[300px] shrink-0 flex-col bg-sidebar max-[1100px]:w-[264px]">
      <div className="flex h-16 shrink-0 items-center px-5">
        <span className="text-[17px] font-semibold tracking-tight">agent-hub</span>
      </div>
      <nav className="flex-1 space-y-2 overflow-y-auto px-3" aria-label="对话列表">
        <Group label="项目经理" entries={direct} activeId={activeId} onSelect={onSelect} />
        <Group label="项目群" entries={groups} activeId={activeId} onSelect={onSelect} />
      </nav>
      <div className="flex gap-2 px-3 pt-3">
        <Button variant="outline" size="sm" className="h-8 flex-1" aria-label="新建项目经理" onClick={onNewPm}>
          <Plus aria-hidden="true" />
          项目经理
        </Button>
        <Button variant="outline" size="sm" className="h-8 flex-1" aria-label="新建项目" onClick={onNewProject}>
          <Plus aria-hidden="true" />
          项目
        </Button>
      </div>
      <div className="flex items-center gap-2.5 px-5 py-4">
        <span className="flex size-9 items-center justify-center rounded-full bg-emerald-600 text-sm font-semibold text-white">
          我
        </span>
        <span className="text-[15px] font-medium">我</span>
      </div>
    </aside>
  );
}
