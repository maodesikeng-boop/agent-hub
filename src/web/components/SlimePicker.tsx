import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { PM_FRUITS } from "../../shared/fruits.ts";
import { JELLY_COLOR_IDS, jellyColorOf, SLIME_SHAPE_LABELS, type SlimeLook } from "../../shared/slimes.ts";
import { errorLine, errorTitle, type ErrorLike } from "../format.ts";
import { jellyStyleOf } from "../lib/palette.ts";
import { cn } from "../lib/utils.ts";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { Avatar } from "./Avatar.tsx";

/** 造型一行 5 个、颜色一行 8 个。 */
const FRUIT_COLUMNS = 5;
const COLOR_COLUMNS = 8;

/** 格子里的键盘：方向键在格子里走（上下按行），Home、End 到头尾；Enter、空格由按钮自己点。 */
function moveFocus(e: KeyboardEvent<HTMLDivElement>, columns: number) {
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
  let next: number | null = null;
  if (e.key in step) next = Math.min(items.length - 1, Math.max(0, index + step[e.key]!));
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  if (next === null) return;
  e.preventDefault();
  items[next]!.focus();
}

/**
 * 换形象的浮层（docs/slime-cohesion-design.md；样子照 docs/ui-standard.md 第 11 条 Popover）：
 * 上面一组 Fruit：20 个造型，都按当前颜色画；下面一组 Color：全部颜色的色板。
 * - 点一个造型或颜色马上调 onChange（只换被点的那一项），浮层不关；选中的造型是果冻底，选中的颜色外面一圈中性细环。
 * - error 不为空时在浮层最下面一行写原因（RowError）；键盘能用方向键在格子里走、Enter 选中，Esc 和点外面关浮层。
 * - children 是触发它的头像按钮（资料页头部、新建项目经理弹窗）。
 */
export function SlimePicker({
  look,
  onChange,
  error,
  children,
}: {
  look: SlimeLook;
  onChange: (next: SlimeLook) => void;
  error?: ErrorLike | null;
  children: ReactElement;
}): ReactNode {
  const fruitsRef = useRef<HTMLDivElement>(null);
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        aria-label="Change look"
        className="flex flex-col gap-4"
        style={jellyStyleOf(look.color)}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          fruitsRef.current?.querySelector<HTMLButtonElement>("[aria-checked=true]")?.focus();
        }}
      >
        <section className="flex flex-col gap-2">
          <h3 id="slime-picker-fruit" className="text-xs font-medium text-muted-foreground">
            Fruit
          </h3>
          <div
            ref={fruitsRef}
            role="radiogroup"
            aria-labelledby="slime-picker-fruit"
            className="grid grid-cols-5 gap-1"
            onKeyDown={(e) => moveFocus(e, FRUIT_COLUMNS)}
          >
            {PM_FRUITS.map((fruit) => {
              const checked = fruit === look.fruit;
              return (
                <button
                  key={fruit}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={SLIME_SHAPE_LABELS[fruit]}
                  title={SLIME_SHAPE_LABELS[fruit]}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => onChange({ fruit, color: look.color })}
                  className={cn(
                    "flex size-12 cursor-pointer items-center justify-center rounded-xl transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    checked ? "bg-jelly" : "hover:bg-jelly-hover",
                  )}
                >
                  <Avatar look={{ fruit, color: look.color }} size={34} />
                </button>
              );
            })}
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h3 id="slime-picker-color" className="text-xs font-medium text-muted-foreground">
            Color
          </h3>
          <div role="radiogroup" aria-labelledby="slime-picker-color" className="grid grid-cols-8 gap-1" onKeyDown={(e) => moveFocus(e, COLOR_COLUMNS)}>
            {JELLY_COLOR_IDS.map((id) => {
              const checked = id === look.color;
              const color = jellyColorOf(id);
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={color.label}
                  title={color.label}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => onChange({ fruit: look.fruit, color: id })}
                  className={cn(
                    "flex size-8 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    checked && "ring-2 ring-ring",
                  )}
                >
                  <span aria-hidden="true" style={{ backgroundColor: color.blob }} className="size-6 rounded-full" />
                </button>
              );
            })}
          </div>
        </section>
        {error != null && (
          <p role="alert" title={errorTitle(error)} className="text-minor text-danger">
            {errorLine(error)}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
