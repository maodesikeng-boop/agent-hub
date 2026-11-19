import { ArrowDown as PxArrowDown } from "pixelarticons/react/ArrowDown.js";
import { Archive as PxArchive } from "pixelarticons/react/Archive.js";
import { ArrowLeft as PxArrowLeft } from "pixelarticons/react/ArrowLeft.js";
import { ArrowsHorizontal as PxArrowsHorizontal } from "pixelarticons/react/ArrowsHorizontal.js";
import { ArrowUp as PxArrowUp } from "pixelarticons/react/ArrowUp.js";
import { Bell as PxBell } from "pixelarticons/react/Bell.js";
import { Blocks as PxBlocks } from "pixelarticons/react/Blocks.js";
import { Calendar as PxCalendar } from "pixelarticons/react/Calendar.js";
import { CellularSignal0 as PxCellularSignal0 } from "pixelarticons/react/CellularSignal0.js";
import { Check as PxCheck } from "pixelarticons/react/Check.js";
import { ChevronDown as PxChevronDown } from "pixelarticons/react/ChevronDown.js";
import { ChevronLeft as PxChevronLeft } from "pixelarticons/react/ChevronLeft.js";
import { ChevronRight as PxChevronRight } from "pixelarticons/react/ChevronRight.js";
import { ChevronsVertical as PxChevronsVertical } from "pixelarticons/react/ChevronsVertical.js";
import { CircleInfo as PxCircleInfo } from "pixelarticons/react/CircleInfo.js";
import { CircleQuestion as PxCircleQuestion } from "pixelarticons/react/CircleQuestion.js";
import { Clock as PxClock } from "pixelarticons/react/Clock.js";
import { Close as PxClose } from "pixelarticons/react/Close.js";
import { Code as PxCode } from "pixelarticons/react/Code.js";
import { Copy as PxCopy } from "pixelarticons/react/Copy.js";
import { Download as PxDownload } from "pixelarticons/react/Download.js";
import { ExternalLink as PxExternalLink } from "pixelarticons/react/ExternalLink.js";
import { FileText as PxFileText } from "pixelarticons/react/FileText.js";
import { Folder as PxFolder } from "pixelarticons/react/Folder.js";
import { FolderPlus as PxFolderPlus } from "pixelarticons/react/FolderPlus.js";
import { GitBranch as PxGitBranch } from "pixelarticons/react/GitBranch.js";
import { Globe as PxGlobe } from "pixelarticons/react/Globe.js";
import { Laptop as PxLaptop } from "pixelarticons/react/Laptop.js";
import { Message as PxMessage } from "pixelarticons/react/Message.js";
import { Monitor as PxMonitor } from "pixelarticons/react/Monitor.js";
import { Pencil as PxPencil } from "pixelarticons/react/Pencil.js";
import { Play as PxPlay } from "pixelarticons/react/Play.js";
import { Plug as PxPlug } from "pixelarticons/react/Plug.js";
import { Plus as PxPlus } from "pixelarticons/react/Plus.js";
import { QrCode as PxQrCode } from "pixelarticons/react/QrCode.js";
import { Reload as PxReload } from "pixelarticons/react/Reload.js";
import { Robot as PxRobot } from "pixelarticons/react/Robot.js";
import { Scale as PxScale } from "pixelarticons/react/Scale.js";
import { Search as PxSearch } from "pixelarticons/react/Search.js";
import { Send as PxSend } from "pixelarticons/react/Send.js";
import { Server as PxServer } from "pixelarticons/react/Server.js";
import { SettingsCog as PxSettingsCog } from "pixelarticons/react/SettingsCog.js";
import { Shield as PxShield } from "pixelarticons/react/Shield.js";
import { Smartphone as PxSmartphone } from "pixelarticons/react/Smartphone.js";
import { SpeedMedium as PxSpeedMedium } from "pixelarticons/react/SpeedMedium.js";
import { SquareAlert as PxSquareAlert } from "pixelarticons/react/SquareAlert.js";
import { Stop as PxStop } from "pixelarticons/react/Stop.js";
import { Tablet as PxTablet } from "pixelarticons/react/Tablet.js";
import { TextCursor as PxTextCursor } from "pixelarticons/react/TextCursor.js";
import { Trash as PxTrash } from "pixelarticons/react/Trash.js";
import { User as PxUser } from "pixelarticons/react/User.js";
import { WarningDiamond as PxWarningDiamond } from "pixelarticons/react/WarningDiamond.js";
import { createElement, type ComponentType, type CSSProperties, type ReactElement, type SVGProps } from "react";

// 全站的图标出口（docs/ui-standard.md 第 5 条）。
// 不变量：
// - 输入框专用的 Composer* 是线条图标（输入框里不用像素）；其余都是像素图标（pixelarticons）：
//   24 格画布、2 格一笔，渲染成 shape-rendering="crispEdges"、fill="currentColor" 的 <svg>，没有描边、渐变和位图。
// - 颜色跟文字走；像素图标的尺寸只由调用方的 class 给：size-pixel（默认“大”档正好 24px）、size-pixel-sm（正好 12px）、
//   size-pixel-lg（正好 48px），四档界面大小下都是整像素格；strokeWidth 这类线条图标的参数传进来不起作用。
// - 没有 aria-label 时 aria-hidden；换一套图标只改这个文件，别的文件不直接 import 图标库。

export type IconProps = SVGProps<SVGSVGElement> & { strokeWidth?: number | string };

/** 取代 lucide 的 LucideIcon：“名字 → 图标”的表（设置分类、系统消息）用它当类型。 */
export type Icon = ComponentType<IconProps>;

type RawPixelIcon = (props: SVGProps<SVGSVGElement>) => ReactElement;

function a11y(props: IconProps): SVGProps<SVGSVGElement> {
  const { strokeWidth: _ignored, ...rest } = props;
  return { "aria-hidden": rest["aria-label"] === undefined ? true : undefined, ...rest };
}

/** data-icon 标出是哪一路图标（守卫测试、样式表认它）：pixel 是像素图标，line 是输入框的线条图标。 */
const PIXEL_MARK = { "data-icon": "pixel" } as SVGProps<SVGSVGElement>;
const LINE_MARK = { "data-icon": "line" } as SVGProps<SVGSVGElement>;

function pixel(raw: RawPixelIcon, name: string): Icon {
  const PixelIcon = (props: IconProps) => createElement(raw, { width: undefined, height: undefined, shapeRendering: "crispEdges", ...PIXEL_MARK, ...a11y(props) });
  PixelIcon.displayName = name;
  return PixelIcon;
}

function line(name: string, d: string, strokeWidth = 1.75, fill = "none"): Icon {
  const LineIcon = (props: IconProps) => createElement(
    "svg",
    { viewBox: "0 0 24 24", fill, stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", ...LINE_MARK, ...a11y(props) },
    createElement("path", { d }),
  );
  LineIcon.displayName = name;
  return LineIcon;
}

export const ComposerAdd = line("ComposerAdd", "M12 5v14M5 12h14");
export const ComposerSend = line("ComposerSend", "M12 19V5m-6 6 6-6 6 6", 2.25);
export const ComposerStop = line("ComposerStop", "M5 5h14v14H5z", 2, "currentColor");
export const ComposerFile = line("ComposerFile", "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6");
export const ComposerVideo = line("ComposerVideo", "M3 6h12v12H3zM15 10l6-3v10l-6-3");
export const ComposerRemove = line("ComposerRemove", "m6 6 12 12M18 6 6 18", 2);
export const ComposerBot = line("ComposerBot", "M12 3v4M5 7h14v12H5zM2 12v3m20-3v3M9 12v1m6-1v1");

// 在忙的转圈：pixelarticons 的 loader 拆成 8 根，按顺序一根根亮（styles.css 的 .pixel-loader），不转动画布，格子一直对齐。
const LOADER_ARMS = [
  "M11 2h2v6h-2z",
  "M15 7h2v2h-2zM17 5h2v2h-2z",
  "M16 11h6v2h-6z",
  "M15 15h2v2h-2zM17 17h2v2h-2z",
  "M11 16h2v6h-2z",
  "M7 15h2v2H7zM5 17h2v2H5z",
  "M2 11h6v2H2z",
  "M7 7h2v2H7zM5 5h2v2H5z",
] as const;

/** 在忙的转圈（自己会动，调用方不用再加 animate-spin）。 */
export const Loader2: Icon = Object.assign(
  (props: IconProps) => {
    const { className, ...rest } = a11y(props);
    return createElement(
      "svg",
      { viewBox: "0 0 24 24", fill: "currentColor", shapeRendering: "crispEdges", ...PIXEL_MARK, className: ["pixel-loader", className].filter(Boolean).join(" "), ...rest },
      ...LOADER_ARMS.map((d, i) => createElement("path", { key: d, d, style: { "--arm": i } as CSSProperties })),
    );
  },
  { displayName: "Loader2" },
);

export const AlertCircle = pixel(PxSquareAlert, "AlertCircle");
export const Archive = pixel(PxArchive, "Archive");
export const ArrowDown = pixel(PxArrowDown, "ArrowDown");
export const ArrowLeft = pixel(PxArrowLeft, "ArrowLeft");
export const ArrowLeftRight = pixel(PxArrowsHorizontal, "ArrowLeftRight");
export const ArrowUp = pixel(PxArrowUp, "ArrowUp");
export const Bell = pixel(PxBell, "Bell");
export const Blocks = pixel(PxBlocks, "Blocks");
export const Bot = pixel(PxRobot, "Bot");
export const Cable = pixel(PxPlug, "Cable");
export const CalendarClock = pixel(PxCalendar, "CalendarClock");
export const ChartNetwork = pixel(PxGitBranch, "ChartNetwork");
export const Check = pixel(PxCheck, "Check");
export const ChevronDown = pixel(PxChevronDown, "ChevronDown");
export const ChevronLeft = pixel(PxChevronLeft, "ChevronLeft");
export const ChevronRight = pixel(PxChevronRight, "ChevronRight");
export const ChevronsUpDown = pixel(PxChevronsVertical, "ChevronsUpDown");
export const CircleAlert = pixel(PxSquareAlert, "CircleAlert");
export const CircleGauge = pixel(PxSpeedMedium, "CircleGauge");
export const CirclePlay = pixel(PxPlay, "CirclePlay");
export const CircleX = pixel(PxClose, "CircleX");
export const Clock = pixel(PxClock, "Clock");
export const Code = pixel(PxCode, "Code");
export const Copy = pixel(PxCopy, "Copy");
export const Download = pixel(PxDownload, "Download");
export const ExternalLink = pixel(PxExternalLink, "ExternalLink");
export const FileText = pixel(PxFileText, "FileText");
export const FolderMinus = pixel(PxFolder, "FolderMinus");
export const FolderPlus = pixel(PxFolderPlus, "FolderPlus");
export const FolderSearch = pixel(PxFolder, "FolderSearch");
export const Globe = pixel(PxGlobe, "Globe");
export const Info = pixel(PxCircleInfo, "Info");
export const Laptop = pixel(PxLaptop, "Laptop");
export const Maximize2 = pixel(PxScale, "Maximize2");
export const MessageCircleQuestionMark = pixel(PxCircleQuestion, "MessageCircleQuestionMark");
export const MessageSquare = pixel(PxMessage, "MessageSquare");
export const Monitor = pixel(PxMonitor, "Monitor");
export const Pencil = pixel(PxPencil, "Pencil");
export const PencilLine = pixel(PxPencil, "PencilLine");
export const Play = pixel(PxPlay, "Play");
export const Plus = pixel(PxPlus, "Plus");
export const QrCode = pixel(PxQrCode, "QrCode");
export const RefreshCw = pixel(PxReload, "RefreshCw");
export const Search = pixel(PxSearch, "Search");
export const Send = pixel(PxSend, "Send");
export const Server = pixel(PxServer, "Server");
export const Settings = pixel(PxSettingsCog, "Settings");
export const Shield = pixel(PxShield, "Shield");
export const Smartphone = pixel(PxSmartphone, "Smartphone");
export const Square = pixel(PxStop, "Square");
export const Tablet = pixel(PxTablet, "Tablet");
export const Trash2 = pixel(PxTrash, "Trash2");
export const TriangleAlert = pixel(PxWarningDiamond, "TriangleAlert");
export const Type = pixel(PxTextCursor, "Type");
export const UserPen = pixel(PxUser, "UserPen");
export const WifiOff = pixel(PxCellularSignal0, "WifiOff");
export const X = pixel(PxClose, "X");
