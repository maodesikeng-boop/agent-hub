// 卡片正文和下面的交付物（shared/deliverables.ts）：对话里的提问卡、右栏的提问和门禁卡、总助的拍板卡和简报都用这里的 CardBody，
// 顺序都是摘要 → 文件 → 细节（默认收起），界面规则见 docs/ui-standard.md 第 22 条。
import { FileText, Play } from "../ui/icons.ts";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FILE_EXPIRED_TEXT, groupDeliverables, previewKindOf, sentFilesOfDeliverables, sentFileUrl, splitLead, type Deliverable, type SentFile } from "../../shared/index.ts";
import { DELIVERABLE_MEDIA_HEIGHT_REM } from "../deliverable-size.ts";
import { useClient } from "../device-scope.tsx";
import { cn } from "../lib/utils.ts";
import { FileCard, useFileExpired } from "./Attachments.tsx";
import { FilePreview, type PreviewFile } from "./FilePreview.tsx";
import { Markdown } from "./Markdown.tsx";

/** 行内蓝色链接（总助简报的链接行也用）：颜色、下划线同 Markdown 里的链接，触屏热区照第 19 条。 */
export const INLINE_LINK_CLASS =
  "touch-target inline-flex cursor-pointer items-center gap-1 rounded-xl text-link underline decoration-link/40 transition-colors outline-none hover:decoration-link focus-visible:ring-2 focus-visible:ring-ring/50";

function usePreview(item: Deliverable): PreviewFile {
  const client = useClient();
  return {
    name: item.name,
    mime: item.mime,
    size: item.size,
    url: client.url(sentFileUrl({ id: item.id, name: item.name })),
    target: item.origin === null ? null : { kind: "sent", messageId: item.origin.messageId, index: item.origin.index },
  };
}

function DocumentLink({ item }: { item: Deliverable }) {
  const [open, setOpen] = useState(false);
  const preview = usePreview(item);
  return (
    <>
      <button type="button" data-file-link className={INLINE_LINK_CLASS} onClick={() => setOpen(true)}>
        <FileText className="size-pixel-sm shrink-0" aria-hidden="true" />
        <span>{item.label}</span>
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** 图片、视频的缩略图：固定高度（`--deliverable-media-height`，96px 标准档，数在 deliverable-size.ts），视频取第一帧盖播放键、不自动播；副本被清理了换成“文件已过期”的卡片。 */
function MediaThumb({ item }: { item: Deliverable }) {
  const [open, setOpen] = useState(false);
  const preview = usePreview(item);
  const [expired, markExpired] = useFileExpired(preview.url, false);
  if (expired) return <FileCard name={item.label} mime={item.mime} detail={FILE_EXPIRED_TEXT} className="h-(--deliverable-media-height) shrink-0" />;
  const video = previewKindOf(item.name, item.mime) === "video";
  return (
    <>
      <button
        type="button"
        aria-label={item.label}
        onClick={() => setOpen(true)}
        className={cn(
          "relative h-(--deliverable-media-height) shrink-0 overflow-hidden rounded-xl border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          video ? "cursor-pointer" : "cursor-zoom-in",
        )}
      >
        {video ? (
          // #t=0.1：iOS Safari 只预载元数据时不画画面，带上起点才显示第一帧
          <video src={`${preview.url}#t=0.1`} preload="metadata" muted playsInline onError={markExpired} className="block aspect-video h-(--deliverable-media-height) w-auto max-w-40 object-cover" />
        ) : (
          <img src={preview.url} alt={item.label} loading="lazy" onError={markExpired} className="block h-(--deliverable-media-height) w-auto max-w-40 object-cover" />
        )}
        {video && (
          <span data-play-badge className="absolute inset-0 m-auto flex size-9 items-center justify-center rounded-full bg-black/55 text-white">
            <Play className="size-pixel translate-x-px fill-current" aria-hidden="true" />
          </span>
        )}
      </button>
      <FilePreview file={preview} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * 文档类一行蓝色文件链接（图标 + 标签），图片和视频一行 96px 高的缩略图（视频盖播放键），点任何一个都打开预览窗（FilePreview）：
 * 图片看大图，视频用原生播放器播，md 渲染，pdf、html 内联。副本被清理了（取文件 404）显示“文件已过期”，不留破图。
 * 文件地址按外层 DeviceScope 的设备取（别的设备的条目要包在那台设备的 DeviceScope 里）。
 * deliverables 为空时什么都不渲染。className 给外边距（和正文隔 8px）。
 */
export const DeliverableFiles = memo(function DeliverableFiles({ deliverables, className }: { deliverables: readonly Deliverable[]; className?: string }) {
  if (deliverables.length === 0) return null;
  const { documents, media } = groupDeliverables(deliverables);
  return (
    <div
      data-deliverables
      style={{ "--deliverable-media-height": `${DELIVERABLE_MEDIA_HEIGHT_REM}rem` } as CSSProperties}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      {documents.length > 0 && (
        <div data-deliverable-documents className="flex flex-wrap items-center gap-x-3 gap-y-1 text-minor">
          {documents.map((item) => (
            <DocumentLink key={item.id} item={item} />
          ))}
        </div>
      )}
      {media.length > 0 && (
        <div data-deliverable-media className="flex gap-2 overflow-x-auto">
          {media.map((item) => (
            <MediaThumb key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
});

const NO_DELIVERABLES: readonly Deliverable[] = [];
/** 细节比这个高（em，按细节框的字号）就收起：Markdown 一行 1.65em、两行 3.3em，链接行一行约 1.5em。 */
const DETAILS_ONE_LINE_MAX_EM = 2.4;
/** 摘要一行的高度（em）：同 styles.css 里 .markdown 的行高。 */
const LEAD_LINE_HEIGHT_EM = 1.65;
/** 读不到 styles.css 的 --card-lead-lines 时（jsdom）摘要按 3 行收。 */
const LEAD_FALLBACK_LINES = 3;
/** jsdom 之类读不到字号时按 16px 算。 */
const FALLBACK_FONT_PX = 16;

/**
 * 卡片正文：第一段摘要（比 3 行多出一行以上才收成 3 行、底部渐隐，行数在 styles.css 的 `--card-lead-lines`）→ 交付物 → 细节（其余段落和 extra）。
 * 细节一行放得下（比如只有一个 PR 链接、一行提交号）就直接显示；超过一行默认收起。一个 `Show more` / `Show less` 同时管摘要的收起和细节，
 * 没有要收的就不出按钮。细节放不放得下是画出来量的：内容或卡片宽度变了，先画出来再量一次，在浏览器绘制之前定下来，不会闪。
 * 量不到高度（没排版）时当放不下。同一张卡换了内容要重置展开状态，调用方给 key。textClassName 是摘要和细节的字号颜色，className 给外边距。
 * files 不传时用交付物本身：正文里写了交付物的同一个链接，也换成能点开的文件。
 */
export const CardBody = memo(function CardBody({
  text,
  deliverables = NO_DELIVERABLES,
  extra,
  files = sentFilesOfDeliverables(deliverables),
  messageId,
  className,
  textClassName,
}: {
  text: string;
  deliverables?: readonly Deliverable[] | undefined;
  /** 接在细节后面、和细节一起收起的东西（总助简报的链接行、拍板卡的下游等待数）。 */
  extra?: ReactNode;
  files?: SentFile[];
  messageId?: number;
  className?: string;
  textClassName?: string;
}) {
  const { lead, details } = useMemo(() => splitLead(text), [text]);
  const hasExtra = extra !== undefined && extra !== null && extra !== false;
  const hasDetails = details !== "" || hasExtra;
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [width, setWidth] = useState(0);
  const [fit, setFit] = useState<{ key: string; oneLine: boolean } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const fitKey = `${width}\u0000${hasExtra}\u0000${details}`;
  const oneLine = fit?.key === fitKey ? fit.oneLine : null;
  const showDetails = hasDetails && (expanded || oneLine !== false);

  // 收起时量一次“摘要比框高”：框宽变了（窗口、托盘滚动条）或摘要变了都重新量；展开时保持上一次的结论，按钮留着好收回去。
  useLayoutEffect(() => {
    const box = leadRef.current;
    if (box === null || expanded) return;
    // 只多出不到一行就不收：Show more 自己要占一行，收起来没省地方，还多点一下
    const measure = () => {
      const style = getComputedStyle(box);
      const lineHeight = LEAD_LINE_HEIGHT_EM * (Number.parseFloat(style.fontSize) || FALLBACK_FONT_PX);
      const lines = Number.parseInt(style.getPropertyValue("--card-lead-lines"), 10) || LEAD_FALLBACK_LINES;
      setOverflowing(box.scrollHeight > (lines + 1) * lineHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.firstElementChild !== null) observer.observe(box.firstElementChild);
    return () => observer.disconnect();
  }, [expanded, lead]);

  useLayoutEffect(() => {
    const box = bodyRef.current;
    if (box === null) return;
    const observer = new ResizeObserver(() => setWidth(Math.round(box.clientWidth)));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const box = detailsRef.current;
    if (oneLine !== null || box === null) return;
    const height = box.getBoundingClientRect().height;
    const fontPx = Number.parseFloat(getComputedStyle(box).fontSize) || FALLBACK_FONT_PX;
    setFit({ key: fitKey, oneLine: height > 0 && height < DETAILS_ONE_LINE_MAX_EM * fontPx });
  });

  if (lead === "" && !hasDetails && deliverables.length === 0) return null;
  return (
    <div ref={bodyRef} id={id} data-card-body className={cn("flex min-w-0 flex-col items-start gap-2", className)}>
      {lead !== "" && (
        <div
          ref={leadRef}
          data-card-lead
          data-overflowing={overflowing && !expanded ? "" : undefined}
          className={cn("w-full min-w-0", textClassName, overflowing && !expanded && "card-lead-clamp")}
        >
          <Markdown text={lead} files={files} messageId={messageId} />
        </div>
      )}
      <DeliverableFiles deliverables={deliverables} className="w-full" />
      {showDetails && (
        <div ref={detailsRef} data-card-details className={cn("flex w-full min-w-0 flex-col gap-2", textClassName)}>
          {details !== "" && <Markdown text={details} files={files} messageId={messageId} />}
          {extra}
        </div>
      )}
      {((hasDetails && oneLine === false) || overflowing) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          className="touch-target inline-flex cursor-pointer items-center rounded-full text-minor text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
});
