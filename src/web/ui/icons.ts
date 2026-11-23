import {
  AlertCircle as LucideAlertCircle,
  Archive as LucideArchive,
  ArrowDown as LucideArrowDown,
  ArrowLeft as LucideArrowLeft,
  ArrowLeftRight as LucideArrowLeftRight,
  ArrowUp as LucideArrowUp,
  Bell as LucideBell,
  Blocks as LucideBlocks,
  Bot as LucideBot,
  Cable as LucideCable,
  CalendarClock as LucideCalendarClock,
  ChartNetwork as LucideChartNetwork,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronUp as LucideChevronUp,
  ChevronsUpDown as LucideChevronsUpDown,
  CircleAlert as LucideCircleAlert,
  CirclePlay as LucideCirclePlay,
  CircleX as LucideCircleX,
  Clock as LucideClock,
  Code as LucideCode,
  Copy as LucideCopy,
  Download as LucideDownload,
  ExternalLink as LucideExternalLink,
  FileText as LucideFileText,
  FolderMinus as LucideFolderMinus,
  FolderPlus as LucideFolderPlus,
  FolderSearch as LucideFolderSearch,
  Globe as LucideGlobe,
  Hourglass as LucideHourglass,
  Info as LucideInfo,
  Laptop as LucideLaptop,
  Loader2 as LucideLoader2,
  Maximize2 as LucideMaximize2,
  MessageCircleQuestionMark as LucideMessageCircleQuestionMark,
  MessageSquare as LucideMessageSquare,
  Monitor as LucideMonitor,
  MoreHorizontal as LucideMoreHorizontal,
  Pencil as LucidePencil,
  PencilLine as LucidePencilLine,
  Pin as LucidePin,
  Play as LucidePlay,
  Plus as LucidePlus,
  QrCode as LucideQrCode,
  RefreshCw as LucideRefreshCw,
  Search as LucideSearch,
  SendHorizontal as LucideSendHorizontal,
  Server as LucideServer,
  Settings as LucideSettings,
  Shield as LucideShield,
  Smartphone as LucideSmartphone,
  Square as LucideSquare,
  Tablet as LucideTablet,
  Trash2 as LucideTrash2,
  TriangleAlert as LucideTriangleAlert,
  Type as LucideType,
  User as LucideUser,
  UserPen as LucideUserPen,
  Video as LucideVideo,
  WifiOff as LucideWifiOff,
  X as LucideX,
  type LucideIcon,
} from "lucide-react";
import { createElement, type ComponentType, type ReactElement, type SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { strokeWidth?: number | string };

export type Icon = ComponentType<IconProps>;

const LINE_MARK = { "data-icon": "line" } as SVGProps<SVGSVGElement>;

function a11y(props: IconProps): IconProps {
  const hasLabel =
    props["aria-label"] !== undefined ||
    props["aria-labelledby"] !== undefined ||
    props.role !== undefined;
  return hasLabel ? props : { "aria-hidden": true, ...props };
}

function smooth(raw: LucideIcon, name: string): Icon {
  const SmoothIcon = (props: IconProps) => createElement(raw, { ...LINE_MARK, ...a11y(props) });
  SmoothIcon.displayName = name;
  return SmoothIcon;
}

function customStroke(name: string, renderChildren: () => ReactElement[]): Icon {
  const CustomIcon = (props: IconProps) =>
    createElement(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: 24,
        height: 24,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        ...LINE_MARK,
        ...a11y(props),
      },
      ...renderChildren(),
    );
  CustomIcon.displayName = name;
  return CustomIcon;
}

export const Loader2: Icon = Object.assign(
  ({ className, ...props }: IconProps) =>
    createElement(LucideLoader2, {
      ...LINE_MARK,
      className: ["animate-spin motion-reduce:animate-none", className].filter(Boolean).join(" "),
      ...a11y(props),
    }),
  { displayName: "Loader2" },
);

const PIN_HEAD_PATH =
  "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z";

export const Pin = smooth(LucidePin, "Pin");
export const PinFilled = customStroke("PinFilled", () => [
  createElement("path", { key: "needle", d: "M12 17v5" }),
  createElement("path", { key: "head", d: PIN_HEAD_PATH, fill: "currentColor" }),
]);

export const DeviceMacos = customStroke("DeviceMacos", () => [
  createElement("path", { key: "leaf", d: "M12 6c.2-1.9 1.6-3.5 3.6-3.8-.2 2-1.6 3.5-3.6 3.8Z" }),
  createElement("path", {
    key: "apple",
    d: "M12 8.5c-1.1 0-2-.9-3.4-.9C6.1 7.6 4 9.9 4 13.4 4 17.3 6.3 21 8.6 21c1.2 0 1.9-.7 3.4-.7s2.2.7 3.4.7c2 0 3.8-2.6 4.4-5-2.5-1.1-2.7-4.5-.2-5.8-.7-1.3-2.1-2.6-4.2-2.6-1.4 0-2.3.9-3.4.9Z",
  }),
]);

export const DeviceWindows = customStroke("DeviceWindows", () => [
  createElement("path", { key: "frame", d: "M3 5.5 21 3v18L3 18.5Z" }),
  createElement("path", { key: "v", d: "M11 4.4v15.2" }),
  createElement("path", { key: "h", d: "M3 12h18" }),
]);

export const DeviceLinux = customStroke("DeviceLinux", () => [
  createElement("path", {
    key: "body",
    d: "M8.2 9.8C8.2 5.2 9.8 3 12 3s3.8 2.2 3.8 6.8c1.7 1.7 2.7 4 2.7 6.3 0 2.8-2 4.4-6.5 4.4s-6.5-1.6-6.5-4.4c0-2.3 1-4.6 2.7-6.3Z",
  }),
  createElement("path", { key: "eye-l", d: "M10.2 7.5h.01" }),
  createElement("path", { key: "eye-r", d: "M13.8 7.5h.01" }),
  createElement("path", { key: "beak", d: "m10.5 10.3 1.5 1.2 1.5-1.2" }),
  createElement("path", { key: "belly", d: "M9 20.2c0-2.8 1.3-4.7 3-4.7s3 1.9 3 4.7" }),
]);

export const DeviceIphone = customStroke("DeviceIphone", () => [
  createElement("rect", { key: "body", x: 6, y: 2, width: 12, height: 20, rx: 2.5 }),
  createElement("path", { key: "island", d: "M10.5 5.2h3" }),
  createElement("path", { key: "home", d: "M10 18.8h4" }),
]);

export const DeviceAndroid = customStroke("DeviceAndroid", () => [
  createElement("path", { key: "dome", d: "M3.5 18.5a8.5 8.5 0 0 1 17 0Z" }),
  createElement("path", { key: "ant-l", d: "m7.5 11.1-2-4.3" }),
  createElement("path", { key: "ant-r", d: "m16.5 11.1 2-4.3" }),
  createElement("path", { key: "eye-l", d: "M9.2 14.5h.01" }),
  createElement("path", { key: "eye-r", d: "M14.8 14.5h.01" }),
]);

export const AlertCircle = smooth(LucideAlertCircle, "AlertCircle");
export const Archive = smooth(LucideArchive, "Archive");
export const ArrowDown = smooth(LucideArrowDown, "ArrowDown");
export const ArrowLeft = smooth(LucideArrowLeft, "ArrowLeft");
export const ArrowLeftRight = smooth(LucideArrowLeftRight, "ArrowLeftRight");
export const ArrowUp = smooth(LucideArrowUp, "ArrowUp");
export const Bell = smooth(LucideBell, "Bell");
export const Blocks = smooth(LucideBlocks, "Blocks");
export const Bot = smooth(LucideBot, "Bot");
export const Cable = smooth(LucideCable, "Cable");
export const CalendarClock = smooth(LucideCalendarClock, "CalendarClock");
export const ChartNetwork = smooth(LucideChartNetwork, "ChartNetwork");
export const Check = smooth(LucideCheck, "Check");
export const ChevronDown = smooth(LucideChevronDown, "ChevronDown");
export const ChevronLeft = smooth(LucideChevronLeft, "ChevronLeft");
export const ChevronRight = smooth(LucideChevronRight, "ChevronRight");
export const ChevronUp = smooth(LucideChevronUp, "ChevronUp");
export const ChevronsUpDown = smooth(LucideChevronsUpDown, "ChevronsUpDown");
export const CircleAlert = smooth(LucideCircleAlert, "CircleAlert");
export const CirclePlay = smooth(LucideCirclePlay, "CirclePlay");
export const CircleX = smooth(LucideCircleX, "CircleX");
export const Clock = smooth(LucideClock, "Clock");
export const Code = smooth(LucideCode, "Code");
export const Copy = smooth(LucideCopy, "Copy");
export const Download = smooth(LucideDownload, "Download");
export const ExternalLink = smooth(LucideExternalLink, "ExternalLink");
export const FileText = smooth(LucideFileText, "FileText");
export const FolderMinus = smooth(LucideFolderMinus, "FolderMinus");
export const FolderPlus = smooth(LucideFolderPlus, "FolderPlus");
export const FolderSearch = smooth(LucideFolderSearch, "FolderSearch");
export const Globe = smooth(LucideGlobe, "Globe");
export const Hourglass = smooth(LucideHourglass, "Hourglass");
export const Info = smooth(LucideInfo, "Info");
export const Laptop = smooth(LucideLaptop, "Laptop");
export const Maximize2 = smooth(LucideMaximize2, "Maximize2");
export const MessageCircleQuestionMark = smooth(LucideMessageCircleQuestionMark, "MessageCircleQuestionMark");
export const MessageSquare = smooth(LucideMessageSquare, "MessageSquare");
export const Monitor = smooth(LucideMonitor, "Monitor");
export const MoreHorizontal = smooth(LucideMoreHorizontal, "MoreHorizontal");
export const Pencil = smooth(LucidePencil, "Pencil");
export const PencilLine = smooth(LucidePencilLine, "PencilLine");
export const Play = smooth(LucidePlay, "Play");
export const Plus = smooth(LucidePlus, "Plus");
export const QrCode = smooth(LucideQrCode, "QrCode");
export const RefreshCw = smooth(LucideRefreshCw, "RefreshCw");
export const Search = smooth(LucideSearch, "Search");
export const Send = smooth(LucideSendHorizontal, "Send");
export const Server = smooth(LucideServer, "Server");
export const Settings = smooth(LucideSettings, "Settings");
export const Shield = smooth(LucideShield, "Shield");
export const Smartphone = smooth(LucideSmartphone, "Smartphone");
export const Square = smooth(LucideSquare, "Square");
export const Tablet = smooth(LucideTablet, "Tablet");
export const Trash2 = smooth(LucideTrash2, "Trash2");
export const TriangleAlert = smooth(LucideTriangleAlert, "TriangleAlert");
export const Type = smooth(LucideType, "Type");
export const User = smooth(LucideUser, "User");
export const UserPen = smooth(LucideUserPen, "UserPen");
export const Video = smooth(LucideVideo, "Video");
export const WifiOff = smooth(LucideWifiOff, "WifiOff");
export const X = smooth(LucideX, "X");
