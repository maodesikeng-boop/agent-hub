import { FileText } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { MenuItem, MenuState } from "../composer-suggest.ts";
import { cn } from "../lib/utils.ts";

const KIND_TEXT = {
  command: { label: "Commands", empty: "No matching commands" },
  file: { label: "Files", empty: "No matching files" },
} as const;

/**
 * 输入框的 “/” 命令、“@” 文件弹出列表。放在输入框正上方、和输入框同宽，在布局里占位（把对话往上顶），不浮在对话正文上面。
 * 最多显示 8 行（每行 h-9 = 2.25rem，所以最高 8*2.25rem），更多的滚动。
 * 鼠标按下时 preventDefault：焦点不离开输入框。高亮只有一个：键盘和鼠标共用。
 */
export function ComposerMenu({
  id,
  menu,
  onSelect,
  onHighlight,
}: {
  id: string;
  menu: MenuState;
  onSelect: (item: MenuItem) => void;
  onHighlight: (index: number) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const text = KIND_TEXT[menu.kind];

  // 键盘翻到看不见的行时滚进来
  useLayoutEffect(() => {
    listRef.current?.children[menu.activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [menu.activeIndex, menu.items]);

  return (
    <div className="mb-2 rounded-2xl border border-border bg-background p-1.5">
      {menu.items.length === 0 ? (
        <p className="flex h-9 items-center px-3 text-minor text-muted-foreground">{text.empty}</p>
      ) : (
        <ul ref={listRef} id={id} role="listbox" aria-label={text.label} className="max-h-[calc(8*2.25rem)] overflow-y-auto">
          {menu.items.map((item, index) => (
            <li
              key={item.id}
              id={optionId(id, index)}
              role="option"
              aria-selected={index === menu.activeIndex}
              className={cn("flex h-9 cursor-pointer items-center gap-3 rounded-xl px-3", index === menu.activeIndex && "bg-sidebar-active")}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => index !== menu.activeIndex && onHighlight(index)}
              onClick={() => onSelect(item)}
            >
              {menu.kind === "file" && <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
              <span className={cn("min-w-0 truncate font-medium", menu.kind === "command" ? "max-w-[45%] shrink-0" : "shrink-0 max-w-[60%]")}>{item.label}</span>
              {item.detail !== "" && <span className="min-w-0 flex-1 truncate text-minor text-muted-foreground">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function optionId(listId: string, index: number): string {
  return `${listId}-${index}`;
}
