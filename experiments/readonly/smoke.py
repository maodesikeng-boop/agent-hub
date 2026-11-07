#!/usr/bin/env python3
"""只读 Worker 统一方案 7.3 的 S1–S6 实测，一键跑（docs/readonly-worker-design.md 第 7.3 节）。

必须在「没包 OS 沙箱」的终端里跑（项目经理或用户自己的终端）：macOS 的沙箱不能嵌套，在 agent-hub 的 Worker 里跑，
claude 自带沙箱、sandbox-exec、codex readOnly 全部 exit 71。脚本一开始会先检查，包着沙箱就直接退出（退出码 2）。

    python3 experiments/readonly/smoke.py                 # 全跑（约 5–8 分钟，要联网、要调 claude/agy/codex 各几次模型）
    python3 experiments/readonly/smoke.py --only S1,S3    # 只跑几项
    python3 experiments/readonly/smoke.py --no-mcp        # S4 不碰 ~/.gemini/config/mcp_config.json（默认会临时加一个测试用 MCP 服务器，跑完恢复）
    python3 experiments/readonly/smoke.py --dry-run       # 只生成并打印所有配置和探针脚本，不调任何厂商程序（也能在沙箱里跑，检查脚本本身）
    python3 experiments/readonly/smoke.py --keep          # 跑完不删临时目录（排查用）

每项输出「通过 / 不通过 / 跳过」加证据（命令的真实输出、磁盘上有没有写成），最后一张汇总表。退出码：全通过 0；有「不通过」1；没有不通过但有「跳过」3；环境不对 2。
完整证据另存 JSON（默认 /tmp/ro-smoke-report-<时间>.json，路径最后会打印；不是临时目录的一部分，不会被清理）。

项目：
  S1 claude 自带沙箱只读档：denyWrite 盖住工作目录和 add-dir 后，Bash 的 echo > / python / touch 写工作目录和外面都失败，TMPDIR 能写，读照常
  S2 claude 自带沙箱网络：network.allowedDomains 写 ["*"] + enableWeakerNetworkIsolation 后 curl、gh、git(https，不读用户 git 配置) 能通；git 走 SSH 应失败（~/.ssh 禁读）（11-07 第一次跑 gh 报 x509 OSStatus -26276，
     原因是沙箱挡了证书服务 com.apple.trustd.agent，加 enableWeakerNetworkIsolation 放行它；不能通配就退回外层沙箱）
  S3 claude 自带沙箱 filesystem.denyRead（~/**/.env 和绝对路径通配）、credentials.files 生效
  S4 agy 外层只读 sandbox-exec profile（设计 4.1）：十几步全对，agy 自己不报写错误，会话能保存、能 --conversation 恢复
  S5 codex readOnly 真跑命令（codex sandbox 确定性 + codex exec 真跑一次）：读外面、只读命令能跑，3 种写都失败；deny_read 配置哪种写法生效
  S6 只读沙箱里 hub 命令照常（hub.sock 能连）：claude 自带沙箱（allowUnixSockets）和外层只读 profile 各试一次；要在 hub 会话里跑（有 HUB_SOCK、HUB_TOKEN）

模型调用是 LLM 驱动的（让它原样跑一个探针脚本），模型偶尔不照做会出「没拿到输出」的不通过，重跑一次即可；判断以磁盘和探针输出为准，不看模型的自述。
S4 的外层只读 profile 和 agy 的 --settings 是 daemon 里真正生成的那两份（node experiments/readonly/agy-launch.ts 打印）；S6 用的 profile 还是脚本里的参考写法。
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

HOME = Path(os.path.realpath(os.path.expanduser("~")))
REPO = Path(__file__).resolve().parents[2]
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
CODEX_FALLBACKS = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    str(HOME / ".codex/plugins/.plugin-appserver/codex-cli/bin/codex"),
]
PASS, FAIL, SKIP = "通过", "不通过", "跳过"
# 厂商命令的最长等待（秒）。
VENDOR_TIMEOUT = 300


# ---------------------------------------------------------------- 基础工具

@dataclass
class Result:
    id: str
    title: str
    status: str = SKIP
    evidence: list[str] = field(default_factory=list)
    raw: dict[str, str] = field(default_factory=dict)

    def note(self, line: str) -> None:
        self.evidence.append(line)


@dataclass
class Run:
    rc: int
    out: str
    err: str
    ms: int


def sh_run(cmd: list[str], *, env: dict[str, str] | None = None, cwd: str | None = None, timeout: int = VENDOR_TIMEOUT) -> Run:
    t0 = time.time()
    try:
        p = subprocess.run(cmd, env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        return Run(p.returncode, p.stdout, p.stderr, int((time.time() - t0) * 1000))
    except subprocess.TimeoutExpired as e:
        return Run(124, (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or ""), f"timeout after {timeout}s", int((time.time() - t0) * 1000))
    except FileNotFoundError as e:
        return Run(127, "", str(e), 0)


def clean_env(*, keep_hub: bool = False, extra: dict[str, str] | None = None) -> dict[str, str]:
    """去掉父会话的 CLAUDE*、HUB_*（跟 run_claude.sh 一样），免得嵌套会话互相串。"""
    env = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE") or k == "ENABLE_TOOL_SEARCH" or (not keep_hub and k.startswith("HUB_")))}
    env.update(extra or {})
    return env


def find_bin(env_name: str, name: str, fallbacks: list[str] | None = None) -> str | None:
    cand = os.environ.get(env_name)
    if cand and os.access(os.path.expanduser(cand), os.X_OK):
        return os.path.expanduser(cand)
    found = shutil.which(name)
    if found:
        return found
    for p in fallbacks or []:
        if os.access(p, os.X_OK):
            return p
    return None


def clip(s: str, n: int = 200) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def sbpl(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


# ---------------------------------------------------------------- 测试现场

class Ctx:
    """临时现场：root 下 ws（git 仓库，当工作目录）、extra（add-dir）、outside（工作目录外，放 note.txt、假密钥 .env）、
    tmpw（会话私有临时目录，只读 profile 里唯一能写的）、probes（探针脚本、配置）。
    另外在用户主目录下建一个 ~/.ro-smoke-<id>/（S3 测 ~/**/.env 要在主目录里），跑完删。"""

    def __init__(self, keep: bool) -> None:
        self.id = uuid.uuid4().hex[:8]
        self.keep = keep
        # 不放在 TMPDIR（macOS 的 /var/folders/…）下：claude 自带沙箱默认就让写自己的临时目录，会盖住 denyWrite 要测的东西
        base = Path(os.path.realpath("/tmp"))
        self.root = Path(tempfile.mkdtemp(prefix="ro-smoke-", dir=base)).resolve()
        self.ws, self.extra, self.outside = self.root / "ws", self.root / "extra", self.root / "outside"
        self.tmpw, self.probes, self.mcp = self.root / "tmpw", self.root / "probes", self.root / "mcp"
        for d in (self.ws, self.extra, self.outside, self.tmpw, self.probes, self.mcp):
            d.mkdir()
        self.marker = f"NOTE-{self.id}"
        self.secret = f"SECRET-{self.id}"
        self.homedir = HOME / f".ro-smoke-{self.id}"
        self.home_probe = HOME / f".ro-smoke-home-write-{self.id}.txt"
        self.tmp_probe = Path("/tmp") / f"ro-smoke-tmp-write-{self.id}.txt"
        (self.outside / "note.txt").write_text(self.marker + "\n")
        (self.outside / ".env").write_text(f"TOKEN={self.secret}\n")
        (self.homedir / "sub").mkdir(parents=True)
        (self.homedir / "sub" / ".env").write_text(f"TOKEN={self.secret}\n")
        (self.homedir / "cred.json").write_text(f'{{"token":"{self.secret}"}}\n')
        (self.homedir / "plain.txt").write_text(self.marker + "\n")
        sh_run(["git", "init", "-q", str(self.ws)])
        (self.ws / "hello.txt").write_text("hello\n")
        sh_run(["git", "-C", str(self.ws), "add", "."])
        sh_run(["git", "-C", str(self.ws), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"])

    def cleanup(self) -> None:
        for p in (self.home_probe, self.tmp_probe):
            p.unlink(missing_ok=True)
        if self.keep:
            print(f"\n（--keep）临时目录没删：{self.root}  和  {self.homedir}", file=sys.stderr)
            return
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.homedir, ignore_errors=True)

    # 不该出现的文件：任何一个存在就是写成了
    def written_files(self) -> list[str]:
        found = []
        for base in (self.ws, self.extra, self.outside, self.homedir):
            for p in base.rglob("w_*"):
                found.append(str(p))
        for p in (self.home_probe, self.tmp_probe, self.root / "w_root.txt"):
            if p.exists():
                found.append(str(p))
        return found


def make_probe(ctx: Ctx, name: str, steps: list[tuple[str, str]], tail: str = "") -> Path:
    """探针脚本：每步 `STEP <名> rc=<退出码> | <输出前 160 个字符>`，最后一行 PROBE_DONE。"""
    lines = [
        "#!/bin/sh",
        "step() { n=$1; shift; o=$(sh -c \"$*\" 2>&1); r=$?; printf 'STEP %s rc=%s | %s\\n' \"$n\" \"$r\" \"$(printf %s \"$o\" | tr '\\n' ' ' | cut -c1-160)\"; }",
    ]
    for n, cmd in steps:
        lines.append(f"step {n} {shlex.quote(cmd)}")
    if tail:
        lines.append(tail)
    lines.append("echo PROBE_DONE")
    path = ctx.probes / name
    path.write_text("\n".join(lines) + "\n")
    path.chmod(0o755)
    return path


STEP_RE = re.compile(r"^STEP (\S+) rc=(\d+) \| ?(.*)$", re.M)


def parse_steps(text: str) -> dict[str, tuple[int, str]]:
    return {m.group(1): (int(m.group(2)), m.group(3)) for m in STEP_RE.finditer(text)}


def write_steps(ctx: Ctx, with_tmpdir: bool = True) -> list[tuple[str, str]]:
    """写类的 3 种命令行写法 × 工作目录/add-dir/外面，加主目录和 /tmp；都应该失败。"""
    q = shlex.quote
    steps = [
        ("w_echo_ws", f"echo x > {q(str(ctx.ws / 'w_echo.txt'))}"),
        ("w_python_ws", f"python3 -c \"open({str(ctx.ws / 'w_py.txt')!r},'w').write('x')\""),
        ("w_touch_ws", f"touch {q(str(ctx.ws / 'w_touch.txt'))}"),
        ("w_echo_extra", f"echo x > {q(str(ctx.extra / 'w_extra.txt'))}"),
        ("w_echo_outside", f"echo x > {q(str(ctx.outside / 'w_outside.txt'))}"),
        ("w_python_outside", f"python3 -c \"open({str(ctx.outside / 'w_py.txt')!r},'w').write('x')\""),
        ("w_touch_outside", f"touch {q(str(ctx.outside / 'w_touch.txt'))}"),
        ("w_home", f"echo x > {q(str(ctx.home_probe))}"),
        ("w_tmp", f"echo x > {q(str(ctx.tmp_probe))}"),
    ]
    if with_tmpdir:
        steps.append(("w_tmpdir", f'echo tmpdir-ok > "$TMPDIR/ro-smoke-{ctx.id}.txt" && cat "$TMPDIR/ro-smoke-{ctx.id}.txt" && rm -f "$TMPDIR/ro-smoke-{ctx.id}.txt"'))
    return steps


def read_steps(ctx: Ctx) -> list[tuple[str, str]]:
    q = shlex.quote
    return [
        ("r_note", f"cat {q(str(ctx.outside / 'note.txt'))}"),
        ("r_ls", f"ls -la {q(str(ctx.outside))}"),
        # 只看 rc：沙箱里 git 会往 stderr 打 DARWIN_USER_TEMP_DIR 警告（rc=0，正常），输出又被截断，不能按输出里有没有 init 判
        ("r_git_log", f"git -C {q(str(ctx.ws))} log --oneline"),
        ("r_etc_hosts", "wc -l /etc/hosts"),
    ]


def check_steps(res: Result, steps: dict[str, tuple[int, str]], ctx: Ctx, *, expect_fail: list[str], expect_ok: dict[str, str | None]) -> bool:
    """逐步对比：expect_fail 里的必须 rc≠0；expect_ok 里的必须 rc=0（值非空的还要输出里含这个字）。返回是否全对。"""
    ok = True
    for name in expect_fail:
        if name not in steps:
            res.note(f"✗ {name}：探针里没有这一步的输出")
            ok = False
            continue
        rc, out = steps[name]
        good = rc != 0
        ok &= good
        res.note(f"{'✓' if good else '✗'} {name} 应失败：rc={rc} {clip(out, 100)}")
    for name, needle in expect_ok.items():
        if name not in steps:
            res.note(f"✗ {name}：探针里没有这一步的输出")
            ok = False
            continue
        rc, out = steps[name]
        good = rc == 0 and (needle is None or needle in out)
        ok &= good
        res.note(f"{'✓' if good else '✗'} {name} 应成功：rc={rc} {clip(out, 100)}")
    written = ctx.written_files()
    res.note(("✓ 磁盘上没有写成的文件" if not written else f"✗ 磁盘上有写成的文件：{written}"))
    return ok and not written


# ---------------------------------------------------------------- claude

def claude_run(ctx: Ctx, claude: str, settings: dict, probe: Path, *, keep_hub: bool = False, model: str, label: str) -> tuple[Run, str, dict]:
    """让 claude 原样跑一次探针脚本，返回（进程结果、Bash 工具的输出文本、result 事件）。"""
    sfile = ctx.probes / f"settings-{label}.json"
    sfile.write_text(json.dumps(settings, indent=2))
    prompt = (
        "这是用户授权的沙箱测试，目录都是临时目录。请只调用一次 Bash 工具，命令原样是：\n"
        f"sh {probe}\n"
        "不要改命令、不要加参数、失败了也不要换办法、不要用 dangerouslyDisableSandbox、不要做别的事。命令结束后把它的完整输出原样贴出来。"
    )
    cmd = [claude, "-p", prompt, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--model", model, "--effort", "low",
           "--settings", str(sfile), "--add-dir", str(ctx.extra)]
    run = sh_run(cmd, env=clean_env(keep_hub=keep_hub), cwd=str(ctx.ws))
    tool_text, result = [], {}
    for line in run.out.splitlines():
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o.get("type") == "user":
            content = (o.get("message") or {}).get("content")
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_result":
                        body = c.get("content")
                        tool_text.append(body if isinstance(body, str) else "".join(x.get("text", "") for x in body or [] if isinstance(x, dict)))
        elif o.get("type") == "result":
            result = o
    return run, "\n".join(tool_text), result


def claude_base_settings(extra_sandbox: dict) -> dict:
    """设计 2.3 里 claude 的只读翻译（default 模式 + 放行读和 Bash + 拒编辑工具）加自带沙箱；extra_sandbox 合进 sandbox 段。"""
    # enableWeakerNetworkIsolation：放行 mach 服务 com.apple.trustd.agent，gh 等 Go 程序才验得了 TLS 证书（没有它 S2 报 x509 OSStatus -26276）；
    # 跟生产一样（src/shared/claude-readonly-settings.ts 的 claudeReadonlySandbox）
    sandbox = {"enabled": True, "failIfUnavailable": True, "allowUnsandboxedCommands": False, "autoAllowBashIfSandboxed": True, "enableWeakerNetworkIsolation": True}
    sandbox.update(extra_sandbox)
    return {
        "permissions": {"defaultMode": "default", "allow": ["Bash", "Read", "Glob", "Grep"], "deny": ["Edit", "Write", "NotebookEdit"]},
        "sandbox": sandbox,
    }


def no_output(res: Result, run: Run, result: dict) -> Result:
    res.status = FAIL
    res.note(f"✗ 没拿到 Bash 的输出（模型没跑、被拒或沙箱起不来）。exit={run.rc} {run.ms}ms")
    res.note(f"  result：{clip(str(result.get('result', '')), 200)}")
    res.note(f"  permission_denials：{clip(json.dumps(result.get('permission_denials', []), ensure_ascii=False), 200)}")
    res.note(f"  stderr：{clip(run.err, 300)}")
    return res


def s1(ctx: Ctx, tools: dict, args) -> Result:
    res = Result("S1", "claude 自带沙箱只读档：命令行写不了（工作目录、add-dir、外面、主目录、/tmp），TMPDIR 能写，读照常")
    settings = claude_base_settings({"filesystem": {"denyWrite": [str(ctx.ws), str(ctx.extra), str(ctx.outside), str(ctx.probes)]}})
    probe = make_probe(ctx, "s1.sh", read_steps(ctx) + write_steps(ctx))
    run, text, result = claude_run(ctx, tools["claude"], settings, probe, model=args.claude_model, label="s1")
    res.raw["tool_output"] = text
    steps = parse_steps(text)
    if "PROBE_DONE" not in text:
        return no_output(res, run, result)
    ok = check_steps(
        res, steps, ctx,
        expect_fail=["w_echo_ws", "w_python_ws", "w_touch_ws", "w_echo_extra", "w_echo_outside", "w_python_outside", "w_touch_outside", "w_home", "w_tmp"],
        expect_ok={"r_note": ctx.marker, "r_ls": None, "r_git_log": None, "r_etc_hosts": None, "w_tmpdir": "tmpdir-ok"},
    )
    res.status = PASS if ok else FAIL
    if not ok:
        res.note("→ 按设计：S1 不过，claude 改 writeGuard: \"outer\"，跟 agy 用同一份只读 profile")
    return res


def s2(ctx: Ctx, tools: dict, args) -> Result:
    res = Result("S2", "claude 自带沙箱网络：allowedDomains [\"*\"] + enableWeakerNetworkIsolation 后 curl、gh、git(https) 能通；git 走 SSH（~/.ssh 私钥）应失败")
    # 跟生产一样禁读 ~/.ssh（只读 Worker 不该拿用户的推送凭证，设计第 5 节）；git 的 https 步骤不读用户的 git 配置，免得 url.insteadOf 把 https 改写成 SSH
    settings = claude_base_settings({"network": {"allowedDomains": ["*"]}, "filesystem": {"denyRead": [str(HOME / ".ssh")]}})
    q = shlex.quote
    no_user_git = "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0"
    ssh_cmd = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
    steps = [
        ("n_curl", "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://api.github.com/zen"),
        ("n_git_lsremote", f"{no_user_git} git ls-remote https://github.com/octocat/Hello-World.git HEAD"),
        ("n_git_fetch_dry", f"{no_user_git} git -C {q(str(ctx.ws))} fetch --dry-run https://github.com/octocat/Hello-World.git master"),
        ("n_gh", "gh api rate_limit --jq .rate.limit"),
        # 用用户自己的 git 配置和 ssh（私钥在 ~/.ssh，被禁读），应该拿不到凭证
        ("n_git_ssh", f"GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND={q(ssh_cmd)} git ls-remote ssh://git@github.com/octocat/Hello-World.git HEAD"),
    ]
    probe = make_probe(ctx, "s2.sh", steps)
    run, text, result = claude_run(ctx, tools["claude"], settings, probe, model=args.claude_model, label="s2")
    res.raw["tool_output"] = text
    got = parse_steps(text)
    if "PROBE_DONE" not in text:
        return no_output(res, run, result)
    ok = True
    for name in ("n_curl", "n_git_lsremote", "n_git_fetch_dry"):
        rc, out = got.get(name, (-1, "没有输出"))
        good = rc == 0 and (name != "n_curl" or out.strip().startswith("200"))
        ok &= good
        res.note(f"{'✓' if good else '✗'} {name} 应成功：rc={rc} {clip(out, 100)}")
    rc, out = got.get("n_gh", (-1, "没有输出"))
    if rc == 0:
        res.note(f"✓ n_gh：rc=0 {clip(out, 60)}")
    elif shutil.which("gh") is None or re.search(r"auth login|GH_TOKEN|not logged|authentication", out, re.I):
        res.note(f"○ n_gh：gh 没装或没登录，无法判断（{clip(out, 80)}），不算不通过；curl、git 通了就说明网络放开了")
    else:
        ok = False
        res.note(f"✗ n_gh 应成功：rc={rc} {clip(out, 100)}")
    rc, out = got.get("n_git_ssh", (0, "没有输出"))
    leaked = bool(re.search(r"\b[0-9a-f]{40}\b", out))
    good = rc != 0 and not leaked
    ok &= good
    keys = [p.name for p in (HOME / ".ssh").glob("id_*") if not p.name.endswith(".pub")] if (HOME / ".ssh").is_dir() else []
    note = "" if keys else "（这台机器 ~/.ssh 里没有私钥，这一项不能说明禁读生效）"
    res.note(f"{'✓' if good else '✗'} n_git_ssh 应失败（私钥被禁读，拿不到推送凭证）：rc={rc} {clip(out, 100)}{note}")
    res.status = PASS if ok else FAIL
    if not ok:
        res.note("→ curl、https 的 git 不通：通配 * 不能用，claude 退回 writeGuard: \"outer\"（外层沙箱不管网络）；只有 gh 报 x509：看 enableWeakerNetworkIsolation 有没有生效；SSH 居然通了：~/.ssh 禁读没生效（或走了 ssh-agent）")
    return res


def s3(ctx: Ctx, tools: dict, args) -> Result:
    res = Result("S3", "claude 自带沙箱 denyRead（~/**/.env、绝对路径通配）和 credentials.files 生效")
    settings = claude_base_settings({
        # 生产的通配写法：**/ 开头的换成绝对根 /**/（claudeReadonlySandbox），所以绝对路径那条测的是 /**/.env
        "filesystem": {"denyRead": ["~/**/.env", "/**/.env"]},
        "credentials": {"files": [{"path": str(ctx.homedir / "cred.json"), "mode": "deny"}]},
    })
    q = shlex.quote
    steps = [
        ("deny_home_env", f"cat {q(str(ctx.homedir / 'sub' / '.env'))}"),
        ("deny_abs_env", f"cat {q(str(ctx.outside / '.env'))}"),
        ("deny_cred_file", f"cat {q(str(ctx.homedir / 'cred.json'))}"),
        ("ctl_note", f"cat {q(str(ctx.outside / 'note.txt'))}"),
        ("ctl_home_plain", f"cat {q(str(ctx.homedir / 'plain.txt'))}"),
    ]
    probe = make_probe(ctx, "s3.sh", steps)
    run, text, result = claude_run(ctx, tools["claude"], settings, probe, model=args.claude_model, label="s3")
    res.raw["tool_output"] = text
    if "PROBE_DONE" not in text:
        return no_output(res, run, result)
    got = parse_steps(text)
    ok = True
    for name in ("deny_home_env", "deny_abs_env", "deny_cred_file"):
        rc, out = got.get(name, (0, "没有输出"))
        good = rc != 0 and ctx.secret not in out
        ok &= good
        res.note(f"{'✓' if good else '✗'} {name} 应被拒（命令报错且看不到内容）：rc={rc} {clip(out.replace(ctx.secret, '<泄露了密钥内容>'), 100)}")
    for name in ("ctl_note", "ctl_home_plain"):
        rc, out = got.get(name, (-1, "没有输出"))
        good = rc == 0 and ctx.marker in out
        ok &= good
        res.note(f"{'✓' if good else '✗'} {name} 对照应能读：rc={rc} {clip(out, 80)}")
    res.status = PASS if ok else FAIL
    return res


# ---------------------------------------------------------------- 外层只读 seatbelt（设计 4.1 的参考写法）

def readonly_profile(ctx: Ctx, runtime_paths: list[str], runtime_regexes: list[str]) -> str:
    """设计 4.1：别的都放行，哪都不能写，只放设备文件、会话私有临时目录、厂商运行时目录；密钥禁读。路径都是真实路径。"""
    lines = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
        f"(allow file-write* (subpath {sbpl(str(ctx.tmpw))}))",
    ]
    lines += [f"(allow file-write* (subpath {sbpl(p)}))" for p in runtime_paths]
    lines += [f'(allow file-write* (regex #"{r}"))' for r in runtime_regexes]
    lines.append('(deny file-read* (regex #"/\\.env(\\..*)?$"))')
    return "\n".join(lines) + "\n"


def agy_runtime(home: Path) -> tuple[list[str], list[str]]:
    """设计 4.1 表里 agy 运行时要写的（只放子目录和具体文件，不放 settings.json、config/）。"""
    cli, gem = home / ".gemini/antigravity-cli", home / ".gemini/antigravity"
    dirs = [str(cli / d) for d in ("conversations", "brain", "cache", "log", "presence", "updater", "crashes", "annotations", "implicit")]
    esc = lambda p: re.sub(r"([.^$*+?()\[\]{}|\\])", r"\\\1", str(p))  # noqa: E731  只转义正则元字符（SBPL 的正则不一定认 \-）
    regexes = [
        "^" + esc(cli) + r"/(cli\.log|conversation_summaries\.db|jetbox_summaries_proto\.pb|last_check\.timestamp)",
        "^" + esc(gem) + r"/(conversation_summaries\.db|agyhub_summaries_proto\.pb)",
    ]
    return dirs, regexes


# ---------------------------------------------------------------- agy

AGY_MCP_SERVER = r"""// S4 用的最小 stdio MCP 服务器（由 smoke.py 生成）：ro_lookup 标了 readOnlyHint，rw_save 标了非只读（会写文件），plain_tool 没有 annotations
import { createInterface } from "node:readline";
import { writeFileSync, appendFileSync } from "node:fs";
const log = (m) => { try { appendFileSync("@CALLS@", m + "\n"); } catch {} };
const tools = [
  { name: "ro_lookup", description: "Look up a value (read-only).", inputSchema: { type: "object", properties: { key: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "rw_save", description: "Save a value to disk.", inputSchema: { type: "object", properties: { value: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "plain_tool", description: "A tool with no annotations.", inputSchema: { type: "object", properties: {} } },
];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "rotest", version: "1.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  else if (m.method === "tools/call") {
    const n = m.params?.name; log("CALL " + n);
    if (n === "rw_save") { try { writeFileSync("@MCPW@", "x"); } catch (e) { log("write failed " + e.message); } }
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: n + " ok" }] } });
  } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
"""


class AgyMcpConfig:
    """临时把 rotest 加进 agy 的全局 MCP 配置（~/.gemini/config/mcp_config.json），退出时无条件恢复备份。"""

    def __init__(self, ctx: Ctx) -> None:
        self.cfg = HOME / ".gemini/config/mcp_config.json"
        self.backup = ctx.probes / "mcp_config.backup.json"
        self.ctx = ctx
        self.active = False

    def enable(self) -> bool:
        if not self.cfg.exists():
            return False
        shutil.copy2(self.cfg, self.backup)
        server = self.ctx.mcp / "server.mjs"
        server.write_text(AGY_MCP_SERVER.replace("@CALLS@", str(self.ctx.tmpw / "mcp-calls.log")).replace("@MCPW@", str(self.ctx.outside / "mcp-w.txt")))
        m = json.loads(self.cfg.read_text())
        m.setdefault("mcpServers", {})["rotest"] = {"command": "node", "args": [str(server)]}
        self.cfg.write_text(json.dumps(m, indent=2))
        self.active = True
        atexit.register(self.restore)
        return True

    def restore(self) -> None:
        if not self.active:
            return
        shutil.copy2(self.backup, self.cfg)
        shutil.rmtree(HOME / ".gemini/antigravity-cli/mcp/rotest", ignore_errors=True)
        self.active = False
        print(f"（agy 的 MCP 配置已恢复：{'一致' if self.cfg.read_bytes() == self.backup.read_bytes() else '不一致！请手动检查 ' + str(self.cfg)}）", file=sys.stderr)


def find_ids(o, out: list[str]) -> None:
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("conversation_id", "conversationId") and isinstance(v, str) and v:
                out.append(v)
            find_ids(v, out)
    elif isinstance(o, list):
        for v in o:
            find_ids(v, out)


def agy_summary(raw: str) -> tuple[list[str], str, list[str], str]:
    """从 stream-json 取：工具调用（名字+状态）、最后的回复、conversation_id 列表、result 的 status。"""
    tools, response, ids, status = [], "", [], ""
    for line in raw.splitlines():
        try:
            o = json.loads(line)
        except ValueError:
            continue
        find_ids(o, ids)
        if o.get("event") == "result":
            r = o.get("result") or {}
            response, status = str(r.get("response", "")), f"status={r.get('status')} denied={r.get('denied_actions')}"
        elif o.get("event") == "step_update":
            su = o.get("step_update") or {}
            if su.get("step_type") == "tool" and su.get("state") in ("DONE", "ERROR", "CANCELED", "CANCELLED"):
                tools.append(f"{su.get('tool_name')}:{su.get('state')}")
    return tools, response, ids, status


def s4(ctx: Ctx, tools: dict, args) -> Result:
    res = Result("S4", "agy 外层只读 profile（设计 4.1）：写不了，读照常，MCP 只读放行，agy 自己不报写错误，会话能保存、能 --conversation 恢复")
    if sys.platform != "darwin":
        res.note("只做 macOS（sandbox-exec）；Linux 的 bwrap 是 W5")
        return res
    agy = tools["agy"]
    mcp = AgyMcpConfig(ctx) if not args.no_mcp else None
    with_mcp = bool(mcp and mcp.enable())
    if not args.no_mcp and not with_mcp:
        res.note("○ 没有 ~/.gemini/config/mcp_config.json，MCP 三步不测")
    try:
        # profile 和 --settings 直接用 daemon 里生成的那两份（src/daemon/driver/readonly-agy.ts、write-scope.ts），连接器清单按测试服务器的声明给：
        # ro_lookup 只读、rw_save 非只读、plain_tool 没标记 → 生成的拒绝规则是 mcp(rotest/rw_save)、mcp(rotest/plain_tool)
        catalog = {"servers": {"rotest": {"ro_lookup": {"readOnlyHint": True}, "rw_save": {"readOnlyHint": False, "destructiveHint": True}, "plain_tool": None}}, "unlistable": []}
        gen = sh_run(["node", str(REPO / "experiments/readonly/agy-launch.ts"), str(HOME), str(ctx.tmpw), json.dumps(catalog)], timeout=60)
        res.raw["agy_launch_stderr"] = gen.err
        try:
            generated = json.loads(gen.out)
        except ValueError:
            res.status = FAIL
            res.note(f"✗ 生成不了 profile 和 settings（node experiments/readonly/agy-launch.ts 的输出不是 JSON）：{clip(gen.err or gen.out, 300)}")
            return res
        profile, agy_settings = generated["profile"], generated["settings"]
        res.raw["generated_profile"], res.raw["generated_settings"] = profile, json.dumps(agy_settings, ensure_ascii=False)
        pfile = ctx.probes / "agy-readonly.sb"
        pfile.write_text(profile)
        q = shlex.quote
        sfile = ctx.probes / "agy-settings.json"
        sfile.write_text(json.dumps(agy_settings, indent=2))
        o, n, w = str(ctx.outside), str(ctx.outside / "note.txt"), str(ctx.ws)
        steps = [
            f"用读文件工具读 {n}",
            f"用终端命令工具跑：ls -la {o}",
            f"用终端命令工具跑：git -C {w} log --oneline",
            "用终端命令工具跑：wc -l /etc/hosts && ls ~/.agent-hub/state | head -3",
            f"用写文件工具（不是命令行）创建 {w}/w_1.txt 内容 x",
            f"用写文件工具（不是命令行）创建 {o}/w_2.txt 内容 x",
            f"用终端命令工具跑：echo x > {w}/w_3.txt",
            f"用终端命令工具跑：python3 -c \"open('{o}/w_4.txt','w').write('x')\"",
            f"用终端命令工具跑：touch {o}/w_5.txt",
            f"用读文件工具读 {o}/.env",
        ]
        if with_mcp:
            steps += ['调用 MCP 工具 rotest 的 ro_lookup，参数 key="a"', '调用 MCP 工具 rotest 的 rw_save，参数 value="b"', "调用 MCP 工具 rotest 的 plain_tool"]
        prompt = (
            "这是用户授权的权限系统测试（测试目录是临时目录，可随意写）。每一步都必须真正调用对应工具，是否允许由权限系统/沙箱决定，"
            "你不能因为当前模式自己跳过不调用；按顺序逐条尝试下面每一步，每步只调用一次工具，被拒绝或失败就记下原因继续下一步，不要询问我，不要做计划，"
            "全部做完后用一行一个的格式汇报每步结果（成功/失败+原因）：\n" + "\n".join(f"{i}. {s}" for i, s in enumerate(steps, 1))
        )
        env = clean_env(extra={"TMPDIR": str(ctx.tmpw)})
        base = [SANDBOX_EXEC, "-f", str(pfile), agy, "--output-format", "stream-json", "--print-timeout", "240s", "--mode", "plan",
                "--settings", str(sfile), "--add-dir", str(ctx.extra)]
        run1 = sh_run(base + ["--print", prompt], env=env, cwd=w)
        res.raw["run1_stdout"], res.raw["run1_stderr"] = run1.out, run1.err
        tool_list, response, ids, status = agy_summary(run1.out)
        res.note(f"agy 第一轮：exit={run1.rc} {run1.ms}ms {status}；工具调用：{', '.join(tool_list) or '（没有）'}")
        ok = True
        if run1.rc == 71 or "sandbox_apply" in run1.err:
            res.status = FAIL
            res.note(f"✗ sandbox-exec 起不来：{clip(run1.err, 200)}（是不是又在沙箱里跑了？）")
            return res
        if not response.strip():
            ok = False
            res.note(f"✗ 回复是空的（整轮被中断？）。stderr：{clip(run1.err, 300)}")
        # 写：磁盘为准
        written = ctx.written_files() + ([str(ctx.outside / "mcp-w.txt")] if (ctx.outside / "mcp-w.txt").exists() else [])
        res.note(("✓ 磁盘上没有写成的文件（w_1…w_5、mcp-w）" if not written else f"✗ 磁盘上有写成的文件：{written}"))
        ok &= not written
        # 读：回复和输出里能看到 note 的内容；.env 的内容不能出现
        saw_note = ctx.marker in run1.out
        res.note(f"{'✓' if saw_note else '✗'} 读外面的文件、跑只读命令：note.txt 的内容出现在输出里")
        ok &= saw_note
        leaked = ctx.secret in run1.out
        res.note(f"{'✗ 密钥内容出现在输出里了' if leaked else '✓ .env 的密钥内容没有出现在输出里'}")
        ok &= not leaked
        # MCP
        if with_mcp:
            calls = (ctx.tmpw / "mcp-calls.log").read_text() if (ctx.tmpw / "mcp-calls.log").exists() else ""
            good = "CALL ro_lookup" in calls and "CALL rw_save" not in calls and "CALL plain_tool" not in calls
            ok &= good
            res.note(f"{'✓' if good else '✗'} MCP：只放行 ro_lookup（服务器收到的调用：{clip(calls, 100) or '无'}）")
        # agy 自己的写错误
        bad = re.findall(r"[^\n]*(?:Operation not permitted|Read-only file system|EPERM|EROFS)[^\n]*", run1.err + run1.out)
        bad = [b for b in bad if "antigravity" in b or ".gemini" in b]
        res.note(f"{'✗ agy 报了自己目录写不了：' + clip(bad[0], 200) if bad else '✓ agy 没报自己运行时目录的写错误'}")
        ok &= not bad
        # 恢复会话
        conv = ids[-1] if ids else ""
        if not conv:
            ok = False
            res.note("✗ 输出里没找到 conversation_id，没法测恢复")
        else:
            run2 = sh_run(base + ["--conversation", conv, "--print", "上一轮我让你读的 note.txt 里那个以 NOTE- 开头的词是什么？只回答这个词。"], env=env, cwd=w)
            res.raw["run2_stdout"], res.raw["run2_stderr"] = run2.out, run2.err
            _, resp2, _, st2 = agy_summary(run2.out)
            good = run2.rc == 0 and bool(resp2.strip())
            ok &= good
            res.note(f"{'✓' if good else '✗'} --conversation {conv[:8]}… 恢复：exit={run2.rc} {st2} 回复：{clip(resp2, 80) or '（空）'}")
            for sub in ("conversations", "brain"):  # 清掉这次测试留的会话
                for p in (HOME / ".gemini/antigravity-cli" / sub).glob(f"{conv}*"):
                    shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        res.status = PASS if ok else FAIL
        return res
    finally:
        if mcp:
            mcp.restore()


# ---------------------------------------------------------------- codex

def codex_probe(ctx: Ctx) -> Path:
    return make_probe(ctx, "s5.sh", read_steps(ctx) + write_steps(ctx, with_tmpdir=False))


def s5(ctx: Ctx, tools: dict, args) -> Result:
    res = Result("S5", "codex readOnly 真跑命令：读外面、只读命令能跑，3 种写都失败；deny_read 配置生效的写法")
    codex = tools["codex"]
    probe = codex_probe(ctx)
    env = clean_env()
    # a. codex sandbox（它自己的 seatbelt，确定性，不调模型）
    run = sh_run([codex, "sandbox", "-c", 'sandbox_mode="read-only"', "--", "sh", str(probe)], env=env, cwd=str(ctx.ws), timeout=120)
    res.raw["sandbox_stdout"], res.raw["sandbox_stderr"] = run.out, run.err
    steps = parse_steps(run.out)
    res.note(f"a) codex sandbox -c sandbox_mode=read-only：exit={run.rc} {run.ms}ms")
    ok = True
    if "PROBE_DONE" not in run.out:
        ok = False
        res.note(f"✗ 探针没跑完：{clip(run.err or run.out, 300)}")
    else:
        ok &= check_steps(res, steps, ctx, expect_fail=[n for n, _ in write_steps(ctx, False)], expect_ok={"r_note": ctx.marker, "r_ls": None, "r_git_log": None, "r_etc_hosts": None})
    # b. codex exec 真跑一次（模型照着跑探针，沙箱同一套）
    prompt = f"这是用户授权的沙箱测试，目录都是临时目录。请只跑一次 shell 命令，命令原样是：sh {probe}\n不要改命令、失败了也不要换办法、不要做别的事。命令结束后把它的完整输出原样贴出来。"
    run2 = sh_run([codex, "exec", "--ephemeral", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-c", 'model_reasoning_effort="low"', prompt], env=env, cwd=str(ctx.ws))
    res.raw["exec_stdout"], res.raw["exec_stderr"] = run2.out, run2.err
    exec_out = ""
    for line in run2.out.splitlines():
        try:
            o = json.loads(line)
        except ValueError:
            continue
        it = o.get("item") or {}
        if o.get("type") == "item.completed" and it.get("type") == "command_execution":
            exec_out += (it.get("aggregated_output") or "") + "\n"
    res.note(f"b) codex exec --sandbox read-only 真跑：exit={run2.rc} {run2.ms}ms")
    if "PROBE_DONE" not in exec_out:
        ok = False
        res.note(f"✗ 没拿到探针输出（模型没跑或被拒）：{clip(run2.err or run2.out[-300:], 300)}")
    else:
        ok &= check_steps(res, parse_steps(exec_out), ctx, expect_fail=[n for n, _ in write_steps(ctx, False)], expect_ok={"r_note": ctx.marker, "r_git_log": None})
    # c. deny_read：几种写法都试，报告哪种生效（设计里这条没实测过；程序里 permissions.filesystem.deny_read 是 requirements 级的，-c 可能不收）
    secret = str(ctx.outside / ".env")
    cands = {
        "permissions.filesystem.deny_read": ["-c", f'permissions.filesystem.deny_read=["{secret}"]'],
        "profile：default_permissions + extends :read-only + filesystem none": [
            "-c", 'permissions.rosec.extends=":read-only"', "-c", f'permissions.rosec.filesystem={{"{secret}"="none"}}', "-c", 'default_permissions="rosec"'],
        "profile：permissions.rosec.filesystem.deny_read": [
            "-c", 'permissions.rosec.extends=":read-only"', "-c", f'permissions.rosec.filesystem.deny_read=["{secret}"]', "-c", 'default_permissions="rosec"'],
    }
    probe_deny = make_probe(ctx, "s5-deny.sh", [("deny_env", f"cat {shlex.quote(secret)}"), ("ctl_note", f"cat {shlex.quote(str(ctx.outside / 'note.txt'))}")])
    worked = None
    for name, cfg in cands.items():
        r = sh_run([codex, "sandbox", "-c", 'sandbox_mode="read-only"', *cfg, "--", "sh", str(probe_deny)], env=env, cwd=str(ctx.ws), timeout=120)
        st = parse_steps(r.out)
        blocked = "deny_env" in st and st["deny_env"][0] != 0 and ctx.secret not in r.out
        control = "ctl_note" in st and st["ctl_note"][0] == 0
        res.note(f"c) deny_read 写法「{name}」：{'生效' if blocked and control else '没生效'}（exit={r.rc}，deny_env={st.get('deny_env', ('无',))[0]}，对照读={'ok' if control else '失败'}）{'' if r.rc == 0 else ' ' + clip(r.err, 120)}")
        if blocked and control and worked is None:
            worked = name
    if worked is None:
        ok = False
        res.note("✗ 没有一种写法让 deny_read 生效。codex 的密钥禁读要么靠权限规则那层（claude/agy 同样的 deny read），要么另想办法（把这条写回设计第 5 节）")
    res.status = PASS if ok else FAIL
    return res


# ---------------------------------------------------------------- hub

def s6(ctx: Ctx, tools: dict, args) -> Result:
    res = Result("S6", "只读沙箱里 hub 命令照常（hub.sock 能连）：claude 自带沙箱 + 外层只读 profile")
    hub_sock, hub_token = os.environ.get("HUB_SOCK"), os.environ.get("HUB_TOKEN")
    hub = shutil.which("hub")
    if not (hub_sock and hub_token and hub):
        res.note(f"跳过：要在 hub 会话里跑（HUB_SOCK={'有' if hub_sock else '没有'}，HUB_TOKEN={'有' if hub_token else '没有'}，hub 命令={'有' if hub else '没有'}）。项目经理的会话里直接跑就有")
        return res
    sock = os.path.realpath(hub_sock)
    ctl = sh_run([hub, "status"], env=clean_env(keep_hub=True), timeout=60)
    res.note(f"对照（没沙箱）hub status：exit={ctl.rc} {clip(ctl.out or ctl.err, 80)}")
    if ctl.rc != 0:
        res.note("跳过：没沙箱 hub status 本身就不通，不是沙箱的问题")
        return res
    ok = True
    # a. 外层只读 profile（确定性）
    dirs, regexes = agy_runtime(HOME)
    pfile = ctx.probes / "readonly.sb"
    pfile.write_text(readonly_profile(ctx, dirs, regexes))
    run = sh_run([SANDBOX_EXEC, "-f", str(pfile), hub, "status"], env=clean_env(keep_hub=True, extra={"TMPDIR": str(ctx.tmpw)}), cwd=str(ctx.ws), timeout=60)
    good = run.rc == 0 and bool(run.out.strip())
    ok &= good
    res.note(f"{'✓' if good else '✗'} 外层只读 profile 里 hub status：exit={run.rc} {clip(run.out or run.err, 100)}")
    # b. claude 自带沙箱（allowUnixSockets 放行 hub.sock，跟 buildSessionSettings 一样）
    settings = claude_base_settings({"filesystem": {"denyWrite": [str(ctx.ws), str(ctx.extra)]}, "network": {"allowUnixSockets": [sock]}})
    probe = make_probe(ctx, "s6.sh", [("hub_status", "hub status")])
    run2, text, result = claude_run(ctx, tools["claude"], settings, probe, keep_hub=True, model=args.claude_model, label="s6")
    res.raw["tool_output"] = text
    st = parse_steps(text)
    if "PROBE_DONE" not in text:
        no_output(res, run2, result)
        ok = False
    else:
        rc, out = st.get("hub_status", (-1, "没有输出"))
        good = rc == 0 and bool(out.strip())
        ok &= good
        res.note(f"{'✓' if good else '✗'} claude 自带沙箱里 hub status：rc={rc} {clip(out, 100)}")
    res.status = PASS if ok else FAIL
    return res


# ---------------------------------------------------------------- 主流程

ALL = {"S1": s1, "S2": s2, "S3": s3, "S4": s4, "S5": s5, "S6": s6}
NEEDS = {"S1": ["claude"], "S2": ["claude"], "S3": ["claude"], "S4": ["agy"], "S5": ["codex"], "S6": []}


def nested_sandbox() -> str | None:
    """已经包在沙箱里就返回原因；macOS 以外不检查。"""
    if sys.platform != "darwin":
        return None
    r = sh_run([SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"], timeout=20)
    return None if r.rc == 0 else f"sandbox-exec 再起一层失败（exit {r.rc}：{clip(r.err, 120)}）——你现在在一个沙箱里（比如 agent-hub 的 Worker）"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="只跑这几项，逗号分隔，如 S1,S3")
    ap.add_argument("--no-mcp", action="store_true", help="S4 不临时改 ~/.gemini/config/mcp_config.json（MCP 三步不测）")
    ap.add_argument("--dry-run", action="store_true", help="只生成并打印配置和探针脚本，不调厂商程序")
    ap.add_argument("--keep", action="store_true", help="不删临时目录")
    ap.add_argument("--claude-model", default="sonnet", help="S1–S3、S6 用的 claude 模型（默认 sonnet）")
    ap.add_argument("--report", help="完整证据 JSON 的路径（默认 /tmp/ro-smoke-report-<时间>.json）")
    args = ap.parse_args()

    wanted = [s.strip().upper() for s in args.only.split(",")] if args.only else list(ALL)
    unknown = [s for s in wanted if s not in ALL]
    if unknown:
        print(f"不认识的项：{unknown}（可选 {list(ALL)}）", file=sys.stderr)
        return 2

    if not args.dry_run:
        why = nested_sandbox()
        if why:
            print(f"不能在这里跑：{why}。换一个没包沙箱的终端再跑（--dry-run 可以在沙箱里检查脚本本身）。", file=sys.stderr)
            return 2

    tools = {
        "claude": find_bin("AGENT_HUB_CLAUDE", "claude"),
        "agy": find_bin("AGENT_HUB_AGY", "agy"),
        "codex": find_bin("AGENT_HUB_CODEX", "codex", CODEX_FALLBACKS),
    }
    print("厂商程序：" + "，".join(f"{k}={v or '没找到'}" for k, v in tools.items()))

    ctx = Ctx(args.keep)
    atexit.register(ctx.cleanup)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # 让 atexit 清理照常跑
    results: list[Result] = []
    if args.dry_run:
        return dry_run(ctx, args)
    for sid in wanted:
        missing = [t for t in NEEDS[sid] if not tools[t]]
        if missing:
            r = Result(sid, ALL[sid].__doc__ or sid)
            r.note(f"跳过：没找到 {missing}（环境变量 AGENT_HUB_{missing[0].upper()} 可以指路径）")
            results.append(r)
            continue
        print(f"\n=== {sid} 跑着…", flush=True)
        try:
            r = ALL[sid](ctx, tools, args)
        except Exception as e:  # noqa: BLE001 - 一项出错不拖垮别的
            r = Result(sid, sid, FAIL, [f"脚本自己出错：{type(e).__name__}: {e}"])
        results.append(r)
        print(f"{sid} {r.status}：{r.title}")
        for e in r.evidence:
            print(f"    {e}")

    print("\n==================== 汇总 ====================")
    for r in results:
        print(f"{r.id}  {r.status}  {r.title}")
    report = Path(args.report or f"/tmp/ro-smoke-report-{time.strftime('%Y%m%dT%H%M%S')}.json")
    report.write_text(json.dumps([r.__dict__ for r in results], ensure_ascii=False, indent=2))
    print(f"完整证据：{report}")
    if any(r.status == FAIL for r in results):
        return 1
    return 3 if any(r.status == SKIP for r in results) else 0


def dry_run(ctx: Ctx, args) -> int:
    """生成所有探针和配置并打印，检查脚本自己（不调厂商程序）。"""
    probes = {
        "s1.sh": read_steps(ctx) + write_steps(ctx),
        "s5.sh": read_steps(ctx) + write_steps(ctx, with_tmpdir=False),
    }
    for name, steps in probes.items():
        print(f"\n--- {name}\n{make_probe(ctx, name, steps).read_text()}")
    print("--- S1 claude 设置\n" + json.dumps(claude_base_settings({"filesystem": {"denyWrite": [str(ctx.ws), str(ctx.extra), str(ctx.outside), str(ctx.probes)]}}), indent=2))
    print("--- S2 claude 设置\n" + json.dumps(claude_base_settings({"network": {"allowedDomains": ["*"]}, "filesystem": {"denyRead": [str(HOME / ".ssh")]}}), indent=2))
    print("--- S3 claude 设置\n" + json.dumps(claude_base_settings({"filesystem": {"denyRead": ["~/**/.env", f"{ctx.root}/**/.env"]}, "credentials": {"files": [{"path": str(ctx.homedir / 'cred.json'), "mode": "deny"}]}}), indent=2))
    dirs, regexes = agy_runtime(HOME)
    print("--- 外层只读 profile（S4、S6）\n" + readonly_profile(ctx, dirs, regexes))
    print(f"（dry-run 现场：{ctx.root}，结束会清掉）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
