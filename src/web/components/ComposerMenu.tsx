import { FileText } from "../ui/icons.ts";
import { useLayoutEffect, useRef } from "react";
import type { MenuItem, MenuKind, MenuState } from "../composer-suggest.ts";
import { cn } from "../lib/utils.ts";
import { Avatar } from "./Avatar.tsx";

const KIND_TEXT: Readonly<Record<MenuKind, { label: string; empty: string }>> = {
  command: { label: "Commands", empty: "No matching commands" },
  file: { label: "Files", empty: "No matching files" },
  target: { label: "Projects", empty: "No matching projects" },
  vendor: { label: "Providers", empty: "No matching providers" },
  model: { label: "Models", empty: "No matching models" },
  effort: { label: "Effort", empty: "No matching effort" },
};

const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

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
              {menu.kind === "file" && <FileText className="size-pixel shrink-0 text-muted-foreground" aria-hidden="true" />}
              {menu.kind === "target" && item.look !== undefined && <Avatar look={item.look} size={20} />}
              <span title={item.label} className={cn("min-w-0 truncate font-medium", menu.kind === "file" ? "shrink-0 max-w-[60%]" : "max-w-[45%] shrink-0", item.disabled && "text-muted-foreground")}>{item.label}</span>
              {item.detail !== "" && <span title={item.detail} className="min-w-0 flex-1 truncate text-minor text-muted-foreground">{item.detail}</span>}
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
