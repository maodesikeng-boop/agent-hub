// 手机设置的行（docs/ui-standard.md 第 9 条“钻取导航行”）：都放在 SettingsGroup 的白底细框里，整行就是热区，不在行右边堆小按钮。
// - SettingsNavRow：整行 <button>，min-h-12 px-4 py-3；左边 16px 线条图标 + 15px 名字（可带一行小字），右边单一结论摘要（tabular-nums，
//   不用 · | / 拼接）+ 16px ChevronRight；危险行（Sign out all browsers…）红字、不带箭头。
// - SwitchRow：整行点哪都拨开关（名字的 label 用 ::after 盖住整行）。
// - FieldBlock：小标题在上、全宽输入框在下的纵向表单块（手机上不把输入框和按钮挤一行，不写死 w-60）。
import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { ErrorLike } from "../../format.ts";
import { cn } from "../../lib/utils.ts";
import { RowError } from "../../components/SettingsList.tsx";
import { Switch } from "../../ui/switch.tsx";

const ROW_ICON = "flex shrink-0 text-muted-foreground [&_svg]:size-4 [&_svg]:stroke-[1.5]";

export function SettingsNavRow({
  icon,
  label,
  detail,
  summary,
  attention = false,
  attentionTestId,
  danger = false,
  className,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  /** 名字下面一行 13.5px 小字（设备的系统与在线状态、浏览器的活跃时间），多项用间距分开。 */
  detail?: ReactNode;
  /** 右边的单一状态结论（Large、On、2 online、3、Pending）。 */
  summary?: ReactNode;
  /** 有要处理的（待批准的浏览器）：摘要前一个 8px 琥珀点。 */
  attention?: boolean;
  attentionTestId?: string;
  danger?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-slot="settings-nav-row"
      className={cn(
        "flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-sidebar-hover focus-visible:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset active:bg-sidebar-hover",
        className,
      )}
      onClick={onClick}
    >
      {icon && <span className={ROW_ICON}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn("block text-body break-words", danger && "text-danger")}>{label}</span>
        {detail && <span className="mt-0.5 block text-minor leading-snug text-muted-foreground">{detail}</span>}
      </span>
      {attention && <span data-testid={attentionTestId} aria-hidden="true" className="size-2 shrink-0 rounded-full bg-caution" />}
      {summary !== undefined && <span className="shrink-0 text-minor text-muted-foreground tabular-nums">{summary}</span>}
      {!danger && <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
    </button>
  );
}

export function SwitchRow({
  label,
  detail,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  detail?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div data-slot="switch-row" className="relative flex min-h-12 items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className={cn("block text-body break-words after:absolute after:inset-0", disabled ? "cursor-default" : "cursor-pointer")}>
          {label}
        </label>
        {detail && <div className="mt-0.5 text-minor leading-snug text-muted-foreground">{detail}</div>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** bare：放在抽屉里（抽屉自己有 px-4），不再套行的内边距。 */
export function FieldBlock({ label, error, bare = false, children }: { label: string; error?: ErrorLike | null; bare?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={cn("grid grid-cols-1 gap-2", !bare && "px-4 py-3")}>
      <label htmlFor={id} className="text-minor font-medium text-muted-foreground">
        {label}
      </label>
      {children(id)}
      {error && <RowError error={error} />}
    </div>
  );
}

/** 等宽代码块（隧道 join 命令、Funnel 命令）：完整折行显示，能整段选中。 */
export function CodeLine({ children }: { children: string }) {
  return <code className="block rounded-xl bg-sidebar px-3 py-2.5 font-mono text-minor break-all select-all">{children}</code>;
}

/** 手机输入框共用的属性：44px 高、全宽；URL、域名、邀请码、连接码这类非自然语言输入关掉 iOS 自动大写、纠错和拼写检查（第 6 条）。 */
export const TOUCH_INPUT = "h-11 w-full";
export const NO_AUTOCORRECT = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false, autoComplete: "off" } as const;
