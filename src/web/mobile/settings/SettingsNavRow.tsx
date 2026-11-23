import { ChevronRight } from "../../ui/icons.ts";
import { useId, type ReactNode } from "react";
import type { ErrorLike } from "../../format.ts";
import { cn } from "../../lib/utils.ts";
import { RowError } from "../../components/SettingsList.tsx";
import { Switch } from "../../ui/switch.tsx";

const ROW_ICON = "flex shrink-0 text-muted-foreground [&_svg]:size-pixel";

export function SettingsNavRow({
  icon,
  label,
  detail,
  summary,
  attention = false,
  attentionTestId,
  danger = false,
  chevron = !danger,
  className,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  summary?: ReactNode;
  attention?: boolean;
  attentionTestId?: string;
  danger?: boolean;
  chevron?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-slot="settings-nav-row"
      className={cn(
        "flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors outline-none hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] active:bg-hover",
        className,
      )}
      onClick={onClick}
    >
      {icon && <span className={ROW_ICON}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn("block text-body break-words", danger && "text-danger")}>{label}</span>
        {detail && <span className="mt-0.5 block text-minor leading-snug text-muted-foreground">{detail}</span>}
      </span>
      {attention && <span data-testid={attentionTestId} aria-hidden="true" className="size-2 shrink-0 bg-caution" />}
      {summary !== undefined && <span className="shrink-0 text-minor text-muted-foreground tabular-nums">{summary}</span>}
      {chevron && <ChevronRight className="size-pixel-sm shrink-0 text-muted-foreground" aria-hidden="true" />}
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

// Disable iOS autocapitalize, autocorrect and spellcheck for URLs, domains and codes.
export const TOUCH_INPUT = "h-11 w-full";
export const NO_AUTOCORRECT = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false, autoComplete: "off" } as const;
