import { useState } from "react";
import { cn } from "../lib/utils.ts";
import { readDropped } from "../upload.ts";

const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * 文件拖到这一块上松手就交给 onFiles；拖着的时候整块高亮。只认文件（选中的文字、链接不管）。
 * 拖进来的文件夹往里读（upload.ts 的 readDropped），读不出文件的原因放在 skipped。
 * 不绑定哪个对话：谁的对话区都可以套一层。
 */
export function FileDropZone({
  onFiles,
  className,
  children,
  ...props
}: { onFiles: (files: File[], skipped: string[]) => void } & Omit<React.ComponentProps<"section">, "onDrop" | "onDragEnter" | "onDragOver" | "onDragLeave">) {
  // dragenter / dragleave 在子元素之间移动时会成对多次触发，用计数判断到底还在不在里面
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
        e.preventDefault(); // 不拦就不能松手
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
