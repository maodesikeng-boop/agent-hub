#!/usr/bin/env bash
# Windows 桌面版 WSL2 专用发行版（Fusa）内受控后台起停与探活脚本。
# 由宿主侧 fusa-supervisor 通过 `wsl.exe --distribution Fusa --user fusa --exec /usr/local/libexec/fusa/wsl-daemon-ctl.sh ...`
# 以独立参数数组调用，严禁拼接 `sh -c`，严禁 `pkill node` / `wsl --terminate` / `wsl --shutdown`。
#
# 子命令：
#   probe --port <端口> [--status-path <路径>] [--timeout-ms <毫秒>]
#   run --run-id <标识> --app-dir <目录> --port <端口> [--home <数据目录>] [--node <node路径>] [--entry <入口相对或绝对路径>]
#   status --run-id <标识> [--home <数据目录>]
#   signal --run-id <标识> --signal <TERM|KILL> [--home <数据目录>]
#   deploy-release --version <版本标识> [--releases-dir <目录>]

set -euo pipefail

FUSA_USER="${FUSA_WSL_USER:-fusa}"
FUSA_HOME="${FUSA_WSL_HOME:-${HOME:-/home/${FUSA_USER}}}"
FUSA_SHARE_DIR="${FUSA_HOME}/.local/share/fusa"
DEFAULT_NODE_BIN="${FUSA_SHARE_DIR}/node/bin/node"
DEFAULT_PNPM_BIN="${FUSA_HOME}/.local/bin/pnpm"
DEFAULT_AGENT_HUB_HOME="${FUSA_HOME}/.agent-hub"
DEFAULT_RELEASES_DIR="${FUSA_SHARE_DIR}/releases"
LOG_MAX_BYTES="${FUSA_LOG_MAX_BYTES:-2097152}"
PROC_ROOT="${FUSA_PROC_ROOT:-/proc}"
EFFECTIVE_UID="${FUSA_EFFECTIVE_UID:-$(id -u)}"

die() {
  printf '[fusa-wsl-ctl] 错误：%s\n' "$*" >&2
  exit 1
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

validate_run_id() {
  local id="$1"
  [[ "$id" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || die "非法的 run-id：${id}"
}

validate_version_id() {
  local id="$1"
  [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] && [[ "$id" != *".."* ]] || die "非法的版本号：${id}"
}

validate_port() {
  local p="$1"
  [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || die "非法的端口号：${p}"
}

lease_file_path() {
  local hub_home="$1" run_id="$2"
  printf '%s/run/wsl-owned-%s.json' "$hub_home" "$run_id"
}

append_ctl_log() {
  local hub_home="$1" msg="$2"
  local log_dir="${hub_home}/state/logs"
  local log_file="${log_dir}/desktop-daemon.log"
  mkdir -p "$log_dir" 2>/dev/null || return 0
  if [ -f "$log_file" ]; then
    local sz=0
    sz=$(wc -c < "$log_file" 2>/dev/null | tr -d '[:space:]' || echo "0")
    if [ "${sz:-0}" -ge "$LOG_MAX_BYTES" ]; then
      mv -f "$log_file" "${log_file}.1" 2>/dev/null || true
    fi
  fi
  printf '%s [fusa-wsl-ctl] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg" >> "$log_file" 2>/dev/null || true
}

# 读取指定 PID 的进程元数据：输出 "<pgid>\t<uid>\t<start_token>"；若进程不存在或已是僵尸进程（Z）则返回非 0。
# Linux（WSL2 生产环境）直接读取 /proc/<pid>/stat（第 22 列不可变 starttime 时钟滴答）；
# 非 Linux 环境（如 macOS 本地测试）回退至 ps 或 perl POSIX 探针。
read_proc_meta() {
  local pid="$1"
  if [ -d "$PROC_ROOT" ] && [ -r "${PROC_ROOT}/self/stat" ]; then
    local stat_file="${PROC_ROOT}/${pid}/stat"
    [ -r "$stat_file" ] || return 1
    local proc_uid=""
    if [ -r "${PROC_ROOT}/${pid}/status" ]; then
      proc_uid=$(awk '$1 == "Uid:" { print $2; exit }' "${PROC_ROOT}/${pid}/status" 2>/dev/null || true)
    fi
    local raw_stat=""
    raw_stat=$(cat "$stat_file" 2>/dev/null) || return 1
    [ -n "$raw_stat" ] || return 1
    local after_comm="${raw_stat##*) }"
    [ "$after_comm" != "$raw_stat" ] || return 1
    local parsed=""
    parsed=$(printf '%s\n' "$after_comm" | awk '{ print $1 "\t" $3 "\t" $20 }')
    local state pgid start_ticks
    IFS=$'\t' read -r state pgid start_ticks <<< "$parsed"
    [ -n "${state:-}" ] && [ -n "${pgid:-}" ] && [ -n "${start_ticks:-}" ] || return 1
    [ "$state" != "Z" ] || return 1
    printf '%s\t%s\t%s\n' "$pgid" "${proc_uid:-$EFFECTIVE_UID}" "$start_ticks"
    return 0
  fi

  local ps_line=""
  ps_line=$(LC_ALL=C ps -o stat=,pgid=,uid=,lstart= -p "$pid" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)
  if [ -n "$ps_line" ]; then
    local state pgid puid lstart
    read -r state pgid puid lstart <<< "$ps_line"
    if [ -n "${state:-}" ] && [ -n "${pgid:-}" ] && [ -n "${lstart:-}" ]; then
      case "$state" in
        Z*) return 1 ;;
      esac
      printf '%s\t%s\t%s\n' "$pgid" "$puid" "${lstart//[[:space:]]/_}"
      return 0
    fi
  fi

  if command -v perl >/dev/null 2>&1; then
    perl -e '
      my $pid = shift;
      exit(1) unless defined($pid) && $pid =~ /^\d+$/ && kill(0, $pid);
      my $pg = eval { getpgrp($pid) };
      $pg = $pid if !defined($pg) || $pg <= 0;
      print "$pg\t$<\tposix-live\n";
    ' "$pid" 2>/dev/null && return 0
  fi
  return 1
}

# 检查 PID 是否已被内核回收并复用给其他新进程（若当前存在同号 PID 但 startTime 不同，则原进程及原同名 PGID 必然早已消亡）。
is_pid_reused_by_other_proc() {
  local pid="$1" expected_start="$2"
  local meta pgid puid actual_start
  meta=$(read_proc_meta "$pid" 2>/dev/null) || return 1
  IFS=$'\t' read -r pgid puid actual_start <<< "$meta"
  [ "$puid" != "$EFFECTIVE_UID" ] || [ "$actual_start" != "$expected_start" ]
}

# 列出属于当前用户、指定进程组 pgid 且非僵尸的所有存活 PID（Linux 下额外要求 starttime >= leader_start_time）。
list_owned_pgid_members() {
  local leader_pid="$1" target_pgid="$2" leader_start="$3"
  if is_pid_reused_by_other_proc "$leader_pid" "$leader_start"; then
    return 0
  fi
  if [ -d "$PROC_ROOT" ] && [ -r "${PROC_ROOT}/self/stat" ]; then
    local entry pid meta pgid puid st
    for entry in "${PROC_ROOT}"/[0-9]*; do
      [ -d "$entry" ] || continue
      pid="${entry##*/}"
      meta=$(read_proc_meta "$pid" 2>/dev/null) || continue
      IFS=$'\t' read -r pgid puid st <<< "$meta"
      [ "$puid" = "$EFFECTIVE_UID" ] || continue
      [ "$pgid" = "$target_pgid" ] || continue
      if [[ "$leader_start" =~ ^[0-9]+$ ]] && [[ "$st" =~ ^[0-9]+$ ]]; then
        [ "$st" -ge "$leader_start" ] || continue
      fi
      printf '%s\n' "$pid"
    done
    return 0
  fi

  local ps_out=""
  ps_out=$(LC_ALL=C ps -ax -o pid=,pgid=,uid=,stat= 2>/dev/null || true)
  if [ -n "$ps_out" ]; then
    printf '%s\n' "$ps_out" | awk -v g="$target_pgid" -v u="$EFFECTIVE_UID" '
      $2 == g && $3 == u && substr($4, 1, 1) != "Z" { print $1 }
    '
    return 0
  fi

  if [ "$target_pgid" = "$leader_pid" ] && kill -0 "-${target_pgid}" 2>/dev/null; then
    printf '%s\n' "-${target_pgid}"
  fi
}

parse_lease_fields() {
  local file="$1"
  [ -f "$file" ] || return 1
  local content
  content=$(cat "$file" 2>/dev/null) || return 1
  local pid pgid start_time
  pid=$(printf '%s\n' "$content" | sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)
  pgid=$(printf '%s\n' "$content" | sed -n 's/.*"pgid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)
  start_time=$(printf '%s\n' "$content" | sed -n 's/.*"startTime":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$pid" ] && [ -n "$pgid" ] && [ -n "$start_time" ] || return 1
  printf '%s\t%s\t%s\n' "$pid" "$pgid" "$start_time"
}

is_verified_leader_alive() {
  local pid="$1" expected_start="$2"
  local meta pgid puid actual_start
  meta=$(read_proc_meta "$pid" 2>/dev/null) || return 1
  IFS=$'\t' read -r pgid puid actual_start <<< "$meta"
  [ "$puid" = "$EFFECTIVE_UID" ] && [ "$actual_start" = "$expected_start" ]
}

# ─────────────────────── 1. WSL 内部 HTTP 探活（严禁跟随 3xx 重定向）───────────────────────
cmd_probe() {
  local port="" status_path="/api/auth/status" timeout_ms="500"
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port="${2:-}"; shift 2 ;;
      --status-path) status_path="${2:-}"; shift 2 ;;
      --timeout-ms) timeout_ms="${2:-}"; shift 2 ;;
      *) die "probe 未知参数：$1" ;;
    esac
  done
  validate_port "$port"
  [[ "$timeout_ms" =~ ^[0-9]+$ ]] || die "非法的 timeout-ms：${timeout_ms}"
  [[ "$status_path" == /* ]] || status_path="/${status_path}"

  local timeout_sec
  timeout_sec=$(awk -v ms="$timeout_ms" 'BEGIN { s = ms / 1000.0; if (s < 0.2) s = 0.2; printf "%.3f", s }')

  local out="" rc=0
  # 不传 -L / --location：严禁自动跟随任何 3xx 重定向；--noproxy '*' 防止环境变量代理劫持回环请求。
  out=$(curl --silent --noproxy '*' \
    --connect-timeout "$timeout_sec" \
    --max-time "$timeout_sec" \
    --header "Host: 127.0.0.1:${port}" \
    --write-out $'\n__FUSA_HTTP_STATUS__:%{http_code}' \
    "http://127.0.0.1:${port}${status_path}" 2>/dev/null) || rc=$?

  if [[ "$out" != *"__FUSA_HTTP_STATUS__:"* ]]; then
    printf '\n__FUSA_HTTP_STATUS__:000\n'
    return "$rc"
  fi
  printf '%s\n' "$out"
  return 0
}

# ─────────────────────── 2. 受控启动自有守护进程（独立进程组 + 身份租约）───────────────────────
cmd_run() {
  local orig_args=("$@")
  local run_id="" app_dir="" port="" hub_home="$DEFAULT_AGENT_HUB_HOME"
  local node_bin="${FUSA_NODE_BIN_OVERRIDE:-$DEFAULT_NODE_BIN}"
  local entry_rel="src/daemon/main.ts"

  while [ $# -gt 0 ]; do
    case "$1" in
      --run-id) run_id="${2:-}"; shift 2 ;;
      --app-dir) app_dir="${2:-}"; shift 2 ;;
      --port) port="${2:-}"; shift 2 ;;
      --home) hub_home="${2:-}"; shift 2 ;;
      --node) node_bin="${2:-}"; shift 2 ;;
      --entry) entry_rel="${2:-}"; shift 2 ;;
      *) die "run 未知参数：$1" ;;
    esac
  done

  validate_run_id "$run_id"
  validate_port "$port"
  [ -n "$app_dir" ] || die "run 缺少 --app-dir"
  [ -d "$app_dir" ] || die "找不到后台应用目录：${app_dir}"

  if [ ! -x "$node_bin" ]; then
    if command -v node >/dev/null 2>&1; then
      node_bin=$(command -v node)
    else
      die "找不到可执行 Node 运行时：${node_bin}"
    fi
  fi

  # 确保当前进程自己是独立进程组组长（PGID == $$），便于后续超时仅精确清理本次进程组，绝不波及外部进程。
  local meta cur_pgid cur_uid cur_start
  meta=$(read_proc_meta "$$") || die "无法读取当前进程元数据"
  IFS=$'\t' read -r cur_pgid cur_uid cur_start <<< "$meta"

  if [ "$cur_pgid" != "$$" ] && [ "${FUSA_SETSID_ENTERED:-0}" != "1" ]; then
    if command -v setsid >/dev/null 2>&1 && setsid --help 2>&1 | grep -q -- '--wait'; then
      FUSA_SETSID_ENTERED=1 exec setsid --wait "$BASH" "$0" "run" "${orig_args[@]}"
    elif command -v perl >/dev/null 2>&1; then
      FUSA_SETSID_ENTERED=1 exec perl -MPOSIX -e 'POSIX::setsid() or die $!; exec @ARGV or die $!' -- "$BASH" "$0" "run" "${orig_args[@]}"
    elif command -v setsid >/dev/null 2>&1; then
      FUSA_SETSID_ENTERED=1 exec setsid "$BASH" "$0" "run" "${orig_args[@]}"
    fi
  fi

  meta=$(read_proc_meta "$$") || die "无法读取新会话组元数据"
  IFS=$'\t' read -r cur_pgid cur_uid cur_start <<< "$meta"

  mkdir -p "${hub_home}/run" "${hub_home}/state/logs"
  chmod 0700 "${hub_home}/run" 2>/dev/null || true

  local lease_file tmp_lease
  lease_file=$(lease_file_path "$hub_home" "$run_id")
  tmp_lease="${lease_file}.tmp.$$"
  umask 077
  printf '{"runId":"%s","pid":%s,"pgid":%s,"startTime":"%s","port":%s}\n' \
    "$(json_escape "$run_id")" "$$" "$cur_pgid" "$(json_escape "$cur_start")" "$port" > "$tmp_lease"
  mv -f "$tmp_lease" "$lease_file"

  append_ctl_log "$hub_home" "启动受控后台 run_id=${run_id} pid=$$ pgid=${cur_pgid} port=${port}"

  local node_bin_dir
  node_bin_dir=$(dirname "$node_bin")
  export AGENT_HUB_HOME="$hub_home"
  export AGENT_HUB_PORT="$port"
  export PATH="${node_bin_dir}:${FUSA_SHARE_DIR}/pnpm/bin:${FUSA_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
  unset WSL_INTEROP WSLENV

  cd "$app_dir"
  exec "$node_bin" "$entry_rel"
}

# ─────────────────────── 3. 查询自有守护进程与进程组存活状态 ───────────────────────
cmd_status() {
  local run_id="" hub_home="$DEFAULT_AGENT_HUB_HOME"
  while [ $# -gt 0 ]; do
    case "$1" in
      --run-id) run_id="${2:-}"; shift 2 ;;
      --home) hub_home="${2:-}"; shift 2 ;;
      *) die "status 未知参数：$1" ;;
    esac
  done
  validate_run_id "$run_id"

  local lease_file fields pid pgid start_time
  lease_file=$(lease_file_path "$hub_home" "$run_id")
  if ! fields=$(parse_lease_fields "$lease_file"); then
    printf '{"found":false,"leader_alive":false,"group_alive":false,"pid":null,"pgid":null}\n'
    return 0
  fi
  IFS=$'\t' read -r pid pgid start_time <<< "$fields"

  local leader_alive=false group_alive=false
  if is_verified_leader_alive "$pid" "$start_time"; then
    leader_alive=true
    group_alive=true
  elif [ "$pgid" = "$pid" ]; then
    local members=""
    members=$(list_owned_pgid_members "$pid" "$pgid" "$start_time" || true)
    if [ -n "$members" ]; then
      group_alive=true
    fi
  fi

  if [ "$leader_alive" = false ] && [ "$group_alive" = false ]; then
    rm -f "$lease_file" 2>/dev/null || true
  fi

  printf '{"found":true,"leader_alive":%s,"group_alive":%s,"pid":%s,"pgid":%s}\n' \
    "$leader_alive" "$group_alive" "$pid" "$pgid"
}

# ─────────────────────── 4. 对核验过身份的自有进程/进程组发送信号 ───────────────────────
cmd_signal() {
  local run_id="" sig_name="" hub_home="$DEFAULT_AGENT_HUB_HOME"
  while [ $# -gt 0 ]; do
    case "$1" in
      --run-id) run_id="${2:-}"; shift 2 ;;
      --signal) sig_name="${2:-}"; shift 2 ;;
      --home) hub_home="${2:-}"; shift 2 ;;
      *) die "signal 未知参数：$1" ;;
    esac
  done
  validate_run_id "$run_id"
  case "$sig_name" in
    TERM|KILL) ;;
    *) die "仅允许发送 TERM 或 KILL 信号（收到：${sig_name}）" ;;
  esac

  local lease_file fields pid pgid start_time
  lease_file=$(lease_file_path "$hub_home" "$run_id")
  if ! fields=$(parse_lease_fields "$lease_file"); then
    printf '{"signaled":false,"reason":"lease_not_found"}\n'
    return 0
  fi
  IFS=$'\t' read -r pid pgid start_time <<< "$fields"

  if [ "$sig_name" = "TERM" ]; then
    if is_verified_leader_alive "$pid" "$start_time"; then
      kill -TERM "$pid" 2>/dev/null || true
      append_ctl_log "$hub_home" "已向自有后台发送 SIGTERM run_id=${run_id} pid=${pid}"
      printf '{"signaled":true,"reason":"sigterm_sent_to_leader","pid":%s}\n' "$pid"
      return 0
    fi
    printf '{"signaled":false,"reason":"leader_already_exited","pid":%s}\n' "$pid"
    return 0
  fi

  # KILL：优雅停止 40 秒超时兜底——仅清理经身份校验的本次自有进程及自有独立进程组成员，绝不触碰外部进程！
  local killed_any=false
  if is_verified_leader_alive "$pid" "$start_time"; then
    if [ "$pgid" = "$pid" ]; then
      kill -KILL -- "-${pgid}" 2>/dev/null || true
    fi
    kill -KILL "$pid" 2>/dev/null || true
    killed_any=true
  fi

  if [ "$pgid" = "$pid" ]; then
    local member_pid
    while IFS= read -r member_pid; do
      [ -n "$member_pid" ] || continue
      kill -KILL -- "$member_pid" 2>/dev/null || true
      killed_any=true
    done < <(list_owned_pgid_members "$pid" "$pgid" "$start_time" || true)
  fi

  append_ctl_log "$hub_home" "优雅停止超时或残留清理：已对自有进程树执行 SIGKILL run_id=${run_id} pid=${pid} pgid=${pgid}"
  printf '{"signaled":%s,"reason":"sigkill_owned_tree","pid":%s,"pgid":%s}\n' "$killed_any" "$pid" "$pgid"
}

# ─────────────────────── 5. 从 stdin 部署发布包到 ext4 版本目录（零 /mnt/c 依赖）───────────────────────
cmd_deploy_release() {
  local version_id="" releases_dir="$DEFAULT_RELEASES_DIR"
  local pnpm_bin="${FUSA_PNPM_BIN_OVERRIDE:-$DEFAULT_PNPM_BIN}"
  local node_bin="${FUSA_NODE_BIN_OVERRIDE:-$DEFAULT_NODE_BIN}"
  local skip_install="0"

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) version_id="${2:-}"; shift 2 ;;
      --releases-dir) releases_dir="${2:-}"; shift 2 ;;
      --skip-install) skip_install="1"; shift ;;
      *) die "deploy-release 未知参数：$1" ;;
    esac
  done
  validate_version_id "$version_id"

  local target_dir="${releases_dir}/${version_id}"
  local current_link="${releases_dir}/current"
  if [ -f "${target_dir}/src/daemon/main.ts" ] && { [ "$skip_install" = "1" ] || [ -d "${target_dir}/node_modules" ]; }; then
    ln -sfn "$target_dir" "$current_link"
    printf '{"deployed":true,"reused":true,"path":"%s"}\n' "$(json_escape "$current_link")"
    return 0
  fi

  mkdir -p "$releases_dir"
  local staging="${releases_dir}/.staging-${version_id}.$$"
  rm -rf "$staging"
  mkdir -p "$staging"

  if ! tar -xzf - -C "$staging"; then
    rm -rf "$staging"
    die "从 stdin 解压发布包失败"
  fi

  if [ ! -f "${staging}/src/daemon/main.ts" ]; then
    rm -rf "$staging"
    die "发布包缺少 src/daemon/main.ts"
  fi

  if [ "$skip_install" != "1" ]; then
    local node_dir
    node_dir=$(dirname "$node_bin")
    export PATH="${node_dir}:${FUSA_SHARE_DIR}/pnpm/bin:${FUSA_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
    if [ ! -x "$pnpm_bin" ] && command -v pnpm >/dev/null 2>&1; then
      pnpm_bin=$(command -v pnpm)
    fi
    [ -x "$pnpm_bin" ] || { rm -rf "$staging"; die "找不到 pnpm：${pnpm_bin}"; }
    if ! (cd "$staging" && "$pnpm_bin" install --frozen-lockfile --prod --reporter=silent); then
      rm -rf "$staging"
      die "在版本目录内执行 pnpm install 失败"
    fi
  fi

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  ln -sfn "$target_dir" "$current_link"
  printf '{"deployed":true,"reused":false,"path":"%s"}\n' "$(json_escape "$current_link")"
}

main() {
  [ $# -gt 0 ] || die "用法：$0 <probe|run|status|signal|deploy-release> [参数...]"
  local sub="$1"
  shift
  case "$sub" in
    probe) cmd_probe "$@" ;;
    run) cmd_run "$@" ;;
    status) cmd_status "$@" ;;
    signal) cmd_signal "$@" ;;
    deploy-release) cmd_deploy_release "$@" ;;
    *) die "未知子命令：${sub}" ;;
  esac
}

main "$@"
