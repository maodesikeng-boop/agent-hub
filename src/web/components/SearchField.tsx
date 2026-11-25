import { Search, X } from "../ui/icons.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";

export function SearchField({
  label,
  value,
  onChange,
  tone = "default",
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  tone?: "default" | "cream";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-sm border border-border-strong pr-0.5 pl-3 transition-[border-color,box-shadow] focus-within:field-focus pointer-coarse:h-auto",
        tone === "cream" ? "bg-list-field" : "bg-background",
        className,
      )}
    >
      <Search className="size-pixel-sm shrink-0 text-muted-foreground" aria-hidden="true" />
      <Input
        type="search"
        aria-label={label}
        placeholder="Search"
        className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 focus:border-0 focus:shadow-none pointer-coarse:h-11"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value.trim() !== "" && (
        <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Clear search" onClick={() => onChange("")}>
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
