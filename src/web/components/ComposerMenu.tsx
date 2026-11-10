import { FileText } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { MenuItem, MenuKind, MenuState } from "../composer-suggest.ts";
import { cn } from "../lib/utils.ts";

const KIND_TEXT: Readonly<Record<MenuKind, { label: string; empty: string }>> = {
  command: { label: "Commands", empty: "No matching commands" },
  file: { label: "Files", empty: "No matching files" },
  vendor: { label: "Providers", empty: "No matching providers" },
  model: { label: "Models", empty: "No matching models" },
  effort: { label: "Effort", empty: "No matching effort" },
};

/** 按下时不让焦点离开输入框：鼠标和手指都拦（手机上点选时软键盘不收），选中靠 click。 */
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

/**
 * 输入框的 “/” 命令、“@” 文件、/hub:worker 各级参数的弹出列表。放在输入框正上方、和输入框同宽，在布局里占位（把对话往上顶），不浮在对话正文上面。
 * 最多显示 8 行（每行 h-9 = 2.25rem，所以最高 8*2.25rem；触屏行高 44px = 2.75rem），更多的滚动。
 * 按下时 preventDefault：焦点不离开输入框。高亮只有一个：键盘和鼠标共用。不能选的行（没登录的厂商）名字是灰的、不高亮、点了不选。
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
        <ul ref={listRef} id={id} role="listbox" aria-label={text.label} className="max-h-[calc(8*2.25rem)] overflow-y-auto pointer-coarse:max-h-[calc(8*2.75rem)]">
          {menu.items.map((item, index) => (
            <li
              key={item.id}
              id={optionId(id, index)}
              role="option"
              aria-selected={index === menu.activeIndex}
              aria-disabled={item.disabled || undefined}
              className={cn(
                "flex h-9 cursor-pointer items-center gap-3 rounded-xl px-3 pointer-coarse:min-h-11",
                index === menu.activeIndex && "bg-sidebar-active",
                item.disabled && "cursor-default",
              )}
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onMouseMove={() => index !== menu.activeIndex && onHighlight(index)}
              onClick={() => onSelect(item)}
            >
              {menu.kind === "file" && <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
              <span className={cn("min-w-0 truncate font-medium", menu.kind === "file" ? "shrink-0 max-w-[60%]" : "max-w-[45%] shrink-0", item.disabled && "text-muted-foreground")}>{item.label}</span>
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
