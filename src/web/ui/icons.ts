import type { ComponentType, SVGProps } from "react";

// 全站唯一的图标出口（docs/slime-cohesion-design.md）：像素图标，组件名沿用原来 lucide-react 的叫法，调用方只改 import 路径。
// 不变量：
// - 每个图标是 24 格画布、2 格一笔的像素画，渲染成 shape-rendering="crispEdges"、fill="currentColor" 的 <svg>，
//   没有描边、渐变和位图；颜色跟文字走（docs/ui-standard.md 第 5 条）。
// - 尺寸只由调用方的 class 给：size-pixel（默认“大”档正好 24px）、size-pixel-sm（正好 12px）；
//   strokeWidth 这类线条图标的参数传进来不起作用。
// - 没有 aria-label 时 aria-hidden；换一套图标只改这个文件。

export type IconProps = SVGProps<SVGSVGElement>;

/** 取代 lucide 的 LucideIcon：“名字 → 图标”的表（设置分类、系统消息）用它当类型。 */
export type Icon = ComponentType<IconProps>;

function notImplemented(): never {
  throw new Error("未实现");
}

export const AlertCircle: Icon = notImplemented;
export const ArrowLeft: Icon = notImplemented;
export const ArrowLeftRight: Icon = notImplemented;
export const ArrowUp: Icon = notImplemented;
export const Bell: Icon = notImplemented;
export const Blocks: Icon = notImplemented;
export const Bot: Icon = notImplemented;
export const Cable: Icon = notImplemented;
export const ChartNetwork: Icon = notImplemented;
export const Check: Icon = notImplemented;
export const ChevronDown: Icon = notImplemented;
export const ChevronLeft: Icon = notImplemented;
export const ChevronRight: Icon = notImplemented;
export const ChevronsUpDown: Icon = notImplemented;
export const CircleAlert: Icon = notImplemented;
export const CircleGauge: Icon = notImplemented;
export const Code: Icon = notImplemented;
export const Copy: Icon = notImplemented;
export const Download: Icon = notImplemented;
export const ExternalLink: Icon = notImplemented;
export const FileText: Icon = notImplemented;
export const FolderSearch: Icon = notImplemented;
export const Globe: Icon = notImplemented;
export const Info: Icon = notImplemented;
export const Laptop: Icon = notImplemented;
export const Loader2: Icon = notImplemented;
export const Maximize2: Icon = notImplemented;
export const MessageCircleQuestionMark: Icon = notImplemented;
export const Monitor: Icon = notImplemented;
export const Paperclip: Icon = notImplemented;
export const Pencil: Icon = notImplemented;
export const Play: Icon = notImplemented;
export const Plus: Icon = notImplemented;
export const QrCode: Icon = notImplemented;
export const Search: Icon = notImplemented;
export const Send: Icon = notImplemented;
export const Server: Icon = notImplemented;
export const Settings: Icon = notImplemented;
export const Shield: Icon = notImplemented;
export const Smartphone: Icon = notImplemented;
export const Square: Icon = notImplemented;
export const Tablet: Icon = notImplemented;
export const Trash2: Icon = notImplemented;
export const TriangleAlert: Icon = notImplemented;
export const Type: Icon = notImplemented;
export const WifiOff: Icon = notImplemented;
export const X: Icon = notImplemented;
