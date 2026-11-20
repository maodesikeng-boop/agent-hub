import { useState } from "react";
import { cn } from "../lib/utils.ts";
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
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-[28px] border-2 border-dashed border-primary bg-background/90 text-title font-medium text-primary">
          Drop to add files
        </div>
      )}
    </section>
  );
}
