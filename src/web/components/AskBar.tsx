import { BellRing, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Message, MessageId } from "../../shared/index.ts";
import { stripMarkdown } from "../plainText.ts";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";

/**
 * 对话顶栏下面固定的“等你确定（N）”条（M5）：项目经理用 hub ask 问了、用户还没处理的事。
 * 点一下展开每个问题的摘要，点某条跳到那条消息；“知道了”清掉这些提醒（用户之后发了消息也会自动清掉，见 selectors.ts 的 pendingAsks）。
 */
export function AskBar({ asks, onJump, onDismiss }: { asks: Message[]; onJump: (messageId: MessageId) => void; onDismiss: (messageIds: MessageId[]) => void }) {
  const [open, setOpen] = useState(false);
  if (asks.length === 0) return null;
  return (
    <div className="shrink-0 px-6 pb-2">
      <Collapsible open={open} onOpenChange={setOpen} className="rounded-2xl bg-primary/10">
        <div className="flex items-center gap-2 pr-2">
          <CollapsibleTrigger className="group flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-2xl px-4 py-2.5 text-left text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <BellRing className="size-4 shrink-0 text-primary" aria-hidden="true" />
            等你确定（{asks.length}）
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
          </CollapsibleTrigger>
          <Button variant="ghost" size="sm" onClick={() => onDismiss(asks.map((a) => a.id))}>
            知道了
          </Button>
        </div>
        <CollapsibleContent>
          <ul className="max-h-48 space-y-1 overflow-y-auto px-2 pb-2">
            {asks.map((ask) => (
              <li key={ask.id}>
                <button
                  type="button"
                  className="block w-full cursor-pointer truncate rounded-xl px-2 py-1.5 text-left text-[13.5px] text-muted-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => onJump(ask.id)}
                >
                  {stripMarkdown(ask.text)}
                </button>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
