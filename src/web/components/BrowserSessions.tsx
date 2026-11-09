// 设置里的“已登录的浏览器”（联机 P6，docs/multi-device-design.md 第 3.4 节）：每个浏览器一行，能单个退出；
// “在手机上登录”显示一次性登录链接的二维码（5 分钟、用一次）；“全部退出”换主钥匙、清所有会话。
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { BrowserSessionInfo, LoginLinkResponse } from "../../shared/index.ts";
import { describeUserAgent, formatAgo, formatCountdown } from "../browser-sessions.ts";
import { ApiError, deleteBrowserSession, fetchBrowserSessions, postApproveBrowserSession, postLoginLink, postLogoutAll } from "../client.ts";
import { Button } from "../ui/button.tsx";
import { QrCode } from "./QrCode.tsx";
import { errorText, type ErrorLike } from "../format.ts";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";

/** 二维码显示期间，每隔多久刷新一次列表（手机扫码登录上了，二维码就收起来）。 */
const SESSIONS_POLL_MS = 3000;
/** “确认全部退出”等多久没再点就退回。 */
const CONFIRM_TIMEOUT_MS = 5000;
/** 倒计时每秒走一次。 */
const COUNTDOWN_TICK_MS = 1000;

/** 退出自己、全部退出之后：刷新页面，接口回 401，页面显示登录提示。 */
const reloadPage = () => location.reload();

export function BrowserSessionsSettings({ onSignedOut = reloadPage }: { onSignedOut?: () => void }) {
  const [sessions, setSessions] = useState<BrowserSessionInfo[] | null>(null);
  const [loadError, setLoadError] = useState<ErrorLike | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, ErrorLike>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingSelf, setConfirmingSelf] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [allError, setAllError] = useState<ErrorLike | null>(null);
  // 二维码：link 是现在显示的那个（null 没显示）；linkBusy 是正在生成；baseline 是生成时已有的浏览器，多出来就是手机登录上了
  const [link, setLink] = useState<LoginLinkResponse | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<ErrorLike | null>(null);
  const [baseline, setBaseline] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setSessions((await fetchBrowserSessions()).sessions);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 点了“退出（当前浏览器）”或“全部退出”没再点确认：几秒后退回去（Safari 点按钮不聚焦，失去焦点的退回对它不起作用）
  useEffect(() => {
    if (!confirmingSelf) return;
    const timer = setTimeout(() => setConfirmingSelf(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirmingSelf]);

  useEffect(() => {
    if (!confirmingAll) return;
    const timer = setTimeout(() => setConfirmingAll(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirmingAll]);

  const expired = link !== null && now >= link.expiresAt;

  // 二维码在显示：倒计时每秒走一次；定时刷新列表，手机登录上了（多出一个浏览器）就收起来
  useEffect(() => {
    if (link === null) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(tick);
  }, [link]);

  useEffect(() => {
    if (link === null || expired) return;
    const poll = setInterval(() => void refresh(), SESSIONS_POLL_MS);
    return () => clearInterval(poll);
  }, [link, expired, refresh]);

  useEffect(() => {
    if (link !== null && sessions?.some((s) => !baseline.has(s.id))) setLink(null);
  }, [link, sessions, baseline]);

  const exit = async (session: BrowserSessionInfo) => {
    setBusy(`exit:${session.id}`);
    setRowErrors(({ [session.id]: _gone, ...rest }) => rest);
    try {
      await deleteBrowserSession(session.id);
    } catch (err) {
      // 别处已经把它退了：当作成功
      if (!(err instanceof ApiError && err.status === 404)) {
        setRowErrors((errors) => ({ ...errors, [session.id]: errorText(err) }));
        setBusy(null);
        if (session.current) setConfirmingSelf(false);
        return;
      }
    }
    setBusy(null);
    if (session.current) return onSignedOut();
    setSessions((list) => list?.filter((s) => s.id !== session.id) ?? null);
  };

  const approve = async (session: BrowserSessionInfo) => {
    setBusy(`approve:${session.id}`);
    setRowErrors(({ [session.id]: _gone, ...rest }) => rest);
    try {
      await postApproveBrowserSession(session.id);
    } catch (err) {
      setRowErrors((errors) => ({ ...errors, [session.id]: errorText(err) }));
      setBusy(null);
      return;
    }
    setBusy(null);
    setSessions((list) => list?.map((s) => (s.id === session.id ? { ...s, status: "active" } : s)) ?? null);
  };

  const exitAll = async () => {
    setBusy("all");
    setAllError(null);
    try {
      await postLogoutAll();
    } catch (err) {
      setAllError(errorText(err));
      setBusy(null);
      setConfirmingAll(false);
      return;
    }
    setBusy(null);
    onSignedOut();
  };

  const showLink = async () => {
    setLinkBusy(true);
    setLinkError(null);
    try {
      setBaseline(new Set(sessions?.map((s) => s.id)));
      setLink(await postLoginLink());
    } catch (err) {
      setLinkError(errorText(err));
    } finally {
      setLinkBusy(false);
    }
  };

  return (
    <SettingsGroup title="已登录的浏览器">
      {sessions === null && loadError === null && (
        <div className="flex min-h-[52px] items-center justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="加载中" />
        </div>
      )}
      {loadError !== null && (
        <div className="py-3">
          <RowError error={loadError} />
        </div>
      )}
      {sessions
        ?.toSorted((a, b) => (a.status === "pending_approval" ? 0 : 1) - (b.status === "pending_approval" ? 0 : 1))
        .map((session) => {
          const name = describeUserAgent(session.userAgent);
          const ago = formatAgo(session.lastSeenAt, now);
          const pending = session.status === "pending_approval";
          const confirming = session.current && confirmingSelf;
          const detail = (
            <span className="inline-flex items-center gap-3">
              {session.current && <span>这个浏览器</span>}
              {pending && <span>待批准</span>}
              {session.viaPublic && <span>经公网</span>}
              <span>{ago}</span>
            </span>
          );
          return (
            <SettingsRow key={session.id} label={name} detail={detail} error={rowErrors[session.id]}>
              {(id) =>
                pending ? (
                  <span className="-mr-3 flex items-center gap-1">
                    <Button variant="ghost" size="sm" aria-label="拒绝" disabled={busy !== null} onClick={() => void exit(session)}>
                      {busy === `exit:${session.id}` && <Loader2 className="animate-spin" aria-hidden="true" />}拒绝
                    </Button>
                    <Button id={id} variant="ghost" size="sm" aria-label="允许" disabled={busy !== null} onClick={() => void approve(session)}>
                      {busy === `approve:${session.id}` && <Loader2 className="animate-spin" aria-hidden="true" />}允许
                    </Button>
                  </span>
                ) : confirming ? (
                  <span className="-mr-3 flex items-center gap-1">
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmingSelf(false)}>
                      取消
                    </Button>
                    <Button
                      id={id}
                      variant="ghost"
                      size="sm"
                      aria-label="确认退出"
                      disabled={busy !== null}
                      className="text-danger hover:text-danger"
                      onClick={() => void exit(session)}
                    >
                      {busy === `exit:${session.id}` && <Loader2 className="animate-spin" aria-hidden="true" />}确认退出
                    </Button>
                  </span>
                ) : (
                  <Button
                    id={id}
                    variant="ghost"
                    size="sm"
                    aria-label={`退出 ${name}`}
                    disabled={busy !== null}
                    className="-mr-3"
                    onClick={() => (session.current ? setConfirmingSelf(true) : void exit(session))}
                  >
                    {busy === `exit:${session.id}` && <Loader2 className="animate-spin" aria-hidden="true" />}退出
                  </Button>
                )
              }
            </SettingsRow>
          );
        })}
      <SettingsRow label="在手机上登录" error={linkError}>
        {(id) => (
          <Button
            id={id}
            variant="ghost"
            size="sm"
            aria-label={link === null ? "显示二维码" : "隐藏"}
            disabled={linkBusy}
            className="-mr-3"
            onClick={() => (link === null ? void showLink() : setLink(null))}
          >
            {linkBusy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {link === null ? "显示二维码" : "隐藏"}
          </Button>
        )}
      </SettingsRow>
      {link !== null && (
        <div className="my-2 flex flex-col items-center gap-3 rounded-2xl bg-sidebar px-4 py-4">
          {expired ? (
            <>
              <p className="text-[15px] text-muted-foreground">已过期</p>
              <Button variant="outline" size="sm" disabled={linkBusy} onClick={() => void showLink()}>
                重新生成
              </Button>
            </>
          ) : (
            <>
              <QrCode text={link.url} label="登录二维码" className="size-40 rounded-xl" />
              <p className="text-[15px] text-muted-foreground tabular-nums">{formatCountdown(link.expiresAt - now)}</p>
            </>
          )}
        </div>
      )}
      <SettingsRow label="所有浏览器" error={allError}>
        {(id) => (
          <Button
            id={id}
            variant="ghost"
            size="sm"
            aria-label={confirmingAll ? "确认全部退出" : "全部退出"}
            disabled={busy !== null}
            className={confirmingAll ? "-mr-3 text-danger hover:text-danger" : "-mr-3"}
            onClick={() => (confirmingAll ? void exitAll() : setConfirmingAll(true))}
            onBlur={() => setConfirmingAll(false)}
          >
            {busy === "all" && <Loader2 className="animate-spin" aria-hidden="true" />}
            {confirmingAll ? "确认全部退出" : "全部退出"}
          </Button>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}
