import { ChevronRight } from "../../ui/icons.ts";
import { useId, type ReactNode } from "react";
import type { ErrorLike } from "../../format.ts";
import { cn } from "../../lib/utils.ts";
import { INFO_ROW, RowError } from "../../components/SettingsList.tsx";
import { Switch } from "../../ui/switch.tsx";

const ROW_ICON = "flex shrink-0 text-muted-foreground [&_svg]:size-4";

export function SettingsNavRow({
  icon,
  label,
  detail,
  summary,
  attention = false,
  attentionTestId,
  danger = false,
  chevron = !danger,
  disabled = false,
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
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-slot="settings-nav-row"
      className={cn(
        INFO_ROW,
        detail ? "py-1" : "h-7.5",
        className,
      )}
      onClick={onClick}
    >
      {icon && <span className={ROW_ICON}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn("block text-minor break-words", danger ? "text-danger" : "text-foreground")}>{label}</span>
        {detail && <span className="block text-xs leading-snug text-muted-foreground">{detail}</span>}
      </span>
      {attention && <span data-testid={attentionTestId} aria-hidden="true" className="size-2 shrink-0 rounded-full bg-danger" />}
      {summary !== undefined && <span className="info-val max-w-44 shrink-0 truncate text-minor tabular-nums">{summary}</span>}
      {chevron && <ChevronRight className="info-chevron size-3.5 shrink-0" aria-hidden="true" />}
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
    <div data-slot="switch-row" className={cn(INFO_ROW, "relative", detail ? "py-1" : "h-7.5")}>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className={cn("block text-minor text-foreground break-words after:absolute after:inset-0", disabled ? "cursor-default" : "cursor-pointer")}>
          {label}
        </label>
        {detail && <div className="text-xs leading-snug text-muted-foreground">{detail}</div>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function FieldBlock({ label, error, bare = false, children }: { label: string; error?: ErrorLike | null; bare?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={cn("grid grid-cols-1 gap-1.5", !bare && "py-1.5")}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
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
