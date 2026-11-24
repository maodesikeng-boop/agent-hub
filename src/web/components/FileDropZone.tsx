import { useState } from "react";
import { cn } from "../lib/utils.ts";
import { Plus } from "../ui/icons.ts";
import { readDropped } from "../upload.ts";

const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

export function FileDropZone({
  onFiles,
  className,
  children,
  ...props
}: { onFiles: (files: File[], skipped: string[]) => void } & Omit<React.ComponentProps<"section">, "onDrop" | "onDragEnter" | "onDragOver" | "onDragLeave">) {
  const [depth, setDepth] = useState(0);
  const dragging = depth > 0;
  return (
    <section
      {...props}
      data-dragging={dragging || undefined}
      className={cn("relative min-w-0", className)}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); // The drop event never fires unless dragover is cancelled.
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (hasFiles(e)) setDepth((d) => Math.max(0, d - 1));
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDepth(0);
        readDropped(e.dataTransfer, onFiles);
      }}
    >
      {children}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-sm border-2 border-dashed border-primary bg-background/85">
          <span className="flex items-center gap-2 rounded-sm bg-background px-4 py-2 text-body font-medium text-primary shadow-[var(--shadow-overlay)]">
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            Drop to add files
          </span>
        </div>
      )}
    </section>
  );
}
