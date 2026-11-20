import { Search, X } from "../ui/icons.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";

export function SearchField({ label, value, onChange, className }: { label: string; value: string; onChange: (value: string) => void; className?: string }) {
  return (
    <div className={cn("flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl bg-sidebar-active pr-0.5 pl-3 pointer-coarse:h-11", className)}>
      <Search className="size-pixel-sm shrink-0 text-muted-foreground" aria-hidden="true" />
      <Input
        type="search"
        aria-label={label}
        placeholder="Search"
        className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 pointer-coarse:h-full"
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
