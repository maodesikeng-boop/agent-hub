#!/usr/bin/env bash
# 把一台 Ubuntu（22.04 / 24.04，普通用户 + 免密 sudo）装成能跑 agent-hub 的机器。幂等：已经装好的步骤直接跳过，随时可以重跑。
#
# 在本机（Mac）上跑，一条命令搞定：
#   scripts/provision-linux.sh [-i 私钥] [--ref git引用] [--port 端口] [--mesh-port 端口] [--user 用户名] [--service 服务名] [--app-dir 目录名] 用户@主机
# 例：
#   scripts/provision-linux.sh -i ~/.ssh/id_ed25519 ubuntu@203.0.113.10
#   scripts/provision-linux.sh --user bellwood-test --port 4417 --mesh-port 4421 --service bellwood-tester bellwood-test@203.0.113.10
#
# 它做的事（对应 docs/linux.md）：
#   1. apt 装 git / 构建依赖 / bubblewrap / rsync 等；加 4GB swap；从 nodejs.org 装 Node ≥ package.json 的 engines；装 pnpm
#      （无 sudo 的测试用户模式下跳过或仅核对系统前置项，缺失时提示管理员操作）
#   2. 代码：用本机 `git archive` 打包 → ssh 管道推过去，不碰 GitHub，服务器上不放任何令牌，也不是 git 仓库
#   3. pnpm install --frozen-lockfile + pnpm build
#   4. 装名单里各家的 CLI（各家 paths.ts 的 installCommand，装到 ~/.local/bin 或 ~/.npm-global/bin）。登录要人来做，脚本不碰凭据
#   5. systemd 用户服务（默认 agent-hub）：只听 127.0.0.1、开机自启（loginctl enable-linger）。不开任何端口、不装 Tailscale、不动云上资源
#
# 要从别的电脑打开网页：ssh -N -L 端口:127.0.0.1:端口 用户@主机（本机端口必须等于服务器端口，界面会校验 Host/Origin 的端口）。
#
# 脚本自己也是它在服务器上跑的那一半：本机把它通过 ssh 的 stdin 送过去，加 --on-server 执行。

set -euo pipefail

# ───────────── 可调的值（集中在这里）─────────────
# 部署哪个版本：以 main 为准（本机要先 git fetch origin）。
DEFAULT_REF="origin/main"
# 服务器上的界面端口。不用默认的 4317：Mac 上的守护进程占着它，而 ssh -L 要求本机端口 = 服务器端口。
DEFAULT_PORT=4318
DEFAULT_MESH_PORT=""
SWAP_SIZE_GB=4
SWAP_FILE=/swapfile
APP_DIR_NAME=agent-hub                 # 代码目录：~/agent-hub
SERVICE_NAME=agent-hub
NODE_MAJOR=24                          # 装哪个大版本；最低版本从 package.json 的 engines 读
APT_PACKAGES=(git curl ca-certificates xz-utils build-essential python3 procps bubblewrap rsync)
READY_TIMEOUT_S=60                     # 起服务后等网页就绪的最长时间
HAS_SUDO=0

log() { printf '\033[1;34m[provision]\033[0m %s\n' "$*"; }
skip() { printf '\033[2m[provision] 跳过：%s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[provision] 失败：%s\033[0m\n' "$*" >&2; exit 1; }

# ═══════════════════════ 服务器这一半 ═══════════════════════
on_server() {
  local port="$DEFAULT_PORT" mesh_port="$DEFAULT_MESH_PORT" target_user="" sha="" host_only=0 arg
  while [ $# -gt 0 ]; do
    arg="$1"; shift
    case "$arg" in
      --port) port="$1"; shift ;;
      --mesh-port) mesh_port="$1"; shift ;;
      --user) target_user="$1"; shift ;;
      --service) SERVICE_NAME="$1"; shift ;;
      --app-dir) APP_DIR_NAME="$1"; shift ;;
      --sha) sha="$1"; shift ;;
      --host-only) host_only=1 ;;
      *) die "未知参数 $arg" ;;
    esac
  done
  [ "$(id -u)" -ne 0 ] || die "不要用 root 跑：CLI 和服务都装在普通用户名下"
  if sudo -n true 2>/dev/null; then HAS_SUDO=1; else HAS_SUDO=0; fi
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"
  export DEBIAN_FRONTEND=noninteractive

  local app="$HOME/$APP_DIR_NAME" incoming="$HOME/.$APP_DIR_NAME-incoming" manifest_dir
  if [ "$host_only" = 1 ] && [ -n "$target_user" ] && [ "$(id -un)" != "$target_user" ]; then
    local target_home
    target_home=$(getent passwd "$target_user" | cut -d: -f6)
    [ -n "$target_home" ] || die "Linux 用户 $target_user 不存在；先建一个不带 sudo 的用户"
    app="$target_home/$APP_DIR_NAME"
    incoming="$target_home/.$APP_DIR_NAME-incoming"
  fi
  manifest_dir=$app
  [ -d "$incoming" ] && manifest_dir=$incoming # 新送来的代码里的 package.json 优先

  if [ "$host_only" = 1 ]; then
    [ "$HAS_SUDO" = 1 ] || die "需要免密 sudo 来安装系统前置依赖"
    step_apt
    step_swap
    step_node "$manifest_dir"
    step_pnpm "$manifest_dir"
    if [ -n "$target_user" ]; then
      id "$target_user" >/dev/null 2>&1 || die "Linux 用户 $target_user 不存在；先建一个不带 sudo 的用户"
      loginctl show-user "$target_user" -p Linger 2>/dev/null | grep -q yes || { log "enable-linger $target_user"; sudo loginctl enable-linger "$target_user"; }
    fi
    return
  fi

  if [ -z "$target_user" ] && [ "$HAS_SUDO" = 0 ]; then
    die "需要免密 sudo（如果是无 sudo 的测试用户请传 --user <用户名>）"
  fi

  step_apt
  step_swap
  step_node "$manifest_dir"
  step_pnpm "$manifest_dir"
  CODE_CHANGED=0 # step_code 置 1 表示有更新（不用返回值：被 || 调用的函数里 set -e 不生效，装失败会被吞掉）
  step_code "$app" "$incoming" "$sha"
  step_clis "$app"
  step_tester_remote "$app" "$target_user"
  step_service "$app" "$port" "$mesh_port" "$CODE_CHANGED"
  step_report "$app" "$port" "$mesh_port"
}

step_apt() {
  local missing=() p
  for p in "${APT_PACKAGES[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  if [ ${#missing[@]} -eq 0 ]; then skip "apt 包都已装好"; return; fi
  [ "$HAS_SUDO" = 1 ] || die "缺少系统包（需要管理员先装）：${missing[*]}"
  log "apt 安装：${missing[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq --no-install-recommends "${missing[@]}"
}

step_swap() {
  local want_kb=$((SWAP_SIZE_GB * 1024 * 1024)) have_kb
  have_kb=$(awk 'NR>1 {s+=$3} END {print s+0}' /proc/swaps)
  if [ "$have_kb" -ge $((want_kb - 1024)) ]; then skip "swap 已有 $((have_kb / 1024)) MB"; return; fi
  if [ "$HAS_SUDO" = 0 ]; then skip "无 sudo，跳过系统 swap 检查（当前 $((have_kb / 1024)) MB）"; return; fi
  log "加 ${SWAP_SIZE_GB}GB swap（${SWAP_FILE}）"
  if [ ! -f "$SWAP_FILE" ]; then
    sudo fallocate -l "${SWAP_SIZE_GB}G" "$SWAP_FILE"
    sudo chmod 600 "$SWAP_FILE"
    sudo mkswap -q "$SWAP_FILE"
  fi
  sudo swapon "$SWAP_FILE" 2>/dev/null || true
  grep -qs "^$SWAP_FILE " /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
}

# 从 package.json 读一个字段（用已有的 python3，不依赖 node，第一次装 node 之前也能用）
pkg_field() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval("d"+sys.argv[2]))' "$1/package.json" "$2"; }

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; } # version_ge 有 要求

step_node() {
  local src="$1" need have="" arch dist_arch base file
  # 代码还没送到（第一次）时用目录里的 package.json；没有就用 NODE_MAJOR 的最新版
  if [ -f "$src/package.json" ]; then need=$(pkg_field "$src" "['engines']['node']" | tr -d '>=^ '); else need="$NODE_MAJOR.0"; fi
  have=$(node -v 2>/dev/null | tr -d v || true)
  if [ -n "$have" ] && version_ge "$have" "$need"; then skip "node ${have}（要求 ≥ ${need}）"; return; fi
  [ "$HAS_SUDO" = 1 ] || die "需要管理员安装 Node >= ${need}（当前 ${have:-未安装}）"
  arch=$(uname -m)
  case "$arch" in x86_64) dist_arch=x64 ;; aarch64) dist_arch=arm64 ;; *) die "不认识的架构 $arch" ;; esac
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  local tmp; tmp=$(mktemp -d)
  file=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-$dist_arch.tar.xz" '$2 ~ a"$" {print $2}')
  [ -n "$file" ] || die "在 $base 里没找到 linux-$dist_arch 的包"
  log "装 Node（${file}）"
  curl -fsSL -o "$tmp/$file" "$base/$file"
  curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" > "$tmp/sum"
  (cd "$tmp" && sha256sum -c sum >/dev/null) || die "$file 校验和不对"
  sudo tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --no-same-owner --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'
  rm -rf "$tmp"
  hash -r
  have=$(node -v | tr -d v)
  version_ge "$have" "$need" || die "装完 node 是 ${have}，仍低于 $need"
}

step_pnpm() {
  local src="$1" want="" have=""
  # 版本以 package.json 的 packageManager（pnpm@x.y.z）为准
  if [ -f "$src/package.json" ]; then want=$(pkg_field "$src" "['packageManager']" | sed 's/^pnpm@//; s/+.*//'); fi
  [ -n "$want" ] || want=10
  have=$(pnpm -v 2>/dev/null || true)
  if [ -n "$have" ] && { [ "$have" = "$want" ] || [ "${have%%.*}" = "$want" ]; }; then skip "pnpm $have"; return; fi
  [ "$HAS_SUDO" = 1 ] || die "需要管理员安装 pnpm@$want（当前 ${have:-未安装}）"
  log "装 pnpm@$want"
  sudo env "PATH=$PATH" npm install -g "pnpm@$want" --no-fund --no-audit --loglevel=error
  hash -r
}

# 把送过来的代码同步到 ~/agent-hub，装依赖并构建。代码没变（提交号一样、dist 还在）就整个跳过；有更新置 CODE_CHANGED=1
step_code() {
  local app="$1" incoming="$2" sha="$3" deployed=""
  mkdir -p "$app"
  if [ -f "$app/.deployed-sha" ]; then deployed=$(cat "$app/.deployed-sha"); fi
  if [ -d "$incoming" ]; then
    log "同步代码到 $app"
    rsync -a --delete --exclude node_modules --exclude dist --exclude .deployed-sha "$incoming/" "$app/"
    rm -rf "$incoming"
  elif [ ! -f "$app/package.json" ]; then
    die "$app 里没有代码，也没收到新代码"
  fi
  if [ -n "$sha" ] && [ "$sha" = "$deployed" ] && [ -d "$app/dist/web" ] && [ -d "$app/node_modules" ]; then
    skip "代码已是 ${sha:0:8}，依赖和构建都在"; return
  fi
  log "pnpm install + build"
  (cd "$app" && pnpm install --frozen-lockfile --reporter=append-only && pnpm build)
  if [ -n "$sha" ]; then echo "$sha" > "$app/.deployed-sha"; fi
  CODE_CHANGED=1
}

# 名单里的各家 CLI，每家一行：编号 TAB 命令名 TAB 安装命令 TAB 登录命令。从代码里各家的声明读（scripts/print-vendors.ts），
# 加厂商不用改这个脚本。安装命令都装到 ~/.local/bin 或 ~/.npm-global/bin，不需要 root（出处见 docs/linux.md 第 3 节）。
vendor_lines() {
  node "$1/scripts/print-vendors.ts"
}

step_clis() {
  local lines id cmd install login
  mkdir -p "$HOME/.local/bin" "$HOME/.npm-global/bin"
  export npm_config_prefix="$HOME/.npm-global"
  export NPM_CONFIG_PREFIX="$HOME/.npm-global"
  lines=$(vendor_lines "$1") || die "读不了厂商名单（node $1/scripts/print-vendors.ts）"
  while IFS=$'\t' read -r -u 3 id cmd install login; do
    if command -v "$cmd" >/dev/null 2>&1; then skip "$cmd 已装（$("$cmd" --version 2>&1 </dev/null | head -n1)）"; continue; fi
    if [ -z "$install" ]; then printf '\033[1;33m[provision] 警告：%s 没写安装命令，要手动装 %s\033[0m\n' "$id" "$cmd"; continue; fi
    log "装 ${id}（${install}）"
    if bash -o pipefail -c "$install" </dev/null; then :; else printf '\033[1;33m[provision] 警告：%s 装失败，其余步骤继续\033[0m\n' "$id"; fi
    hash -r
  done 3<<<"$lines"
}

step_tester_remote() {
  local app="$1" target_user="$2"
  if [ -f "$app/test/tester/remote-command.sh" ] && { [ -n "$target_user" ] || [ "$SERVICE_NAME" != "agent-hub" ]; }; then
    mkdir -p "$HOME/bin"
    install -m 0700 "$app/test/tester/remote-command.sh" "$HOME/bin/tester-remote"
  fi
}

unit_text() {
  local app="$1" port="$2" mesh_port="$3"
  local mesh_line=""
  if [ -n "$mesh_port" ]; then
    mesh_line=$'\n'"Environment=FUSA_MESH_PORT=$mesh_port"
  fi
  cat <<EOF
[Unit]
Description=$SERVICE_NAME 守护进程（只听 127.0.0.1:${port}）
After=network-online.target

[Service]
WorkingDirectory=$app
# 用户服务的 PATH 很短：node、pnpm、git、各家 CLI 都靠这一行找到
Environment=PATH=$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
Environment=AGENT_HUB_PORT=$port${mesh_line}
EnvironmentFile=-$HOME/.config/systemd/user/$SERVICE_NAME.env
EnvironmentFile=-$HOME/.config/systemd/user/$SERVICE_NAME.mode.env
ExecStart=/usr/bin/env node src/daemon/main.ts
Restart=on-failure
RestartSec=5
# 守护进程关机最多 30 秒，多留几秒
TimeoutStopSec=40

[Install]
WantedBy=default.target
EOF
}

step_service() {
  local app="$1" port="$2" mesh_port="$3" code_changed="$4"
  local unit_dir="$HOME/.config/systemd/user" unit="$HOME/.config/systemd/user/$SERVICE_NAME.service" restart=0
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  mkdir -p "$unit_dir"
  local new; new=$(unit_text "$app" "$port" "$mesh_port")
  if [ ! -f "$unit" ] || [ "$new" != "$(cat "$unit")" ]; then
    log "写 systemd 用户服务 $unit"
    printf '%s\n' "$new" > "$unit"
    systemctl --user daemon-reload
    restart=1
  else
    skip "systemd 单元没变"
  fi
  # 没登录也开机自启、退出 ssh 不被停
  if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes; then
    [ "$HAS_SUDO" = 1 ] || die "需要管理员执行：sudo loginctl enable-linger $USER"
    log "enable-linger"
    sudo loginctl enable-linger "$USER"
  fi
  systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1
  if [ "$restart" = 1 ] || [ "$code_changed" = 1 ] || ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
    log "(重)启动服务"
    systemctl --user restart "$SERVICE_NAME"
  else
    skip "服务在跑，代码和单元都没变"
  fi
}

step_report() {
  local app="$1" port="$2" mesh_port="$3" i code=000
  for ((i = 0; i < READY_TIMEOUT_S; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$port/" || true)
    [ "$code" = 200 ] && break
    sleep 1
  done
  [ "$code" = 200 ] || { journalctl --user -u "$SERVICE_NAME" -n 30 --no-pager || true; die "网页 $READY_TIMEOUT_S 秒内没就绪（HTTP ${code}）"; }
  log "网页就绪：http://127.0.0.1:$port/${mesh_port:+（mesh 端口 $mesh_port）}"
  echo "── 监听（只应看到 127.0.0.1）──"; ss -ltnH "sport = :$port"
  echo "── 内存 ──"; free -m
  local pid; pid=$(systemctl --user show -p MainPID --value "$SERVICE_NAME")
  if [ "$pid" != 0 ]; then echo "守护进程 RSS：$(awk '/VmRSS/ {printf "%d MB", $2/1024}' "/proc/$pid/status")"; fi
  echo "── CLI ──"
  local lines id cmd install login logins=()
  lines=$(vendor_lines "$app") || die "读不了厂商名单（node $app/scripts/print-vendors.ts）"
  while IFS=$'\t' read -r -u 3 id cmd install login; do
    if command -v "$cmd" >/dev/null 2>&1; then echo "$cmd: $("$cmd" --version 2>&1 </dev/null | head -n1)"; else echo "$cmd: 未安装"; fi
    logins+=("$id: $login")
  done 3<<<"$lines"
  echo "── 登录（要人来做，凭据只存在这台机器上）──"
  printf '%s\n' "${logins[@]}"
  echo "界面令牌：cat ~/.agent-hub/state/ui-token（本机浏览器打开 http://127.0.0.1:$port/auth?token=<令牌>）"
}

# ═══════════════════════ 本机这一半 ═══════════════════════
on_local() {
  local key="" ref="$DEFAULT_REF" port="$DEFAULT_PORT" mesh_port="$DEFAULT_MESH_PORT" target_user="" service="$SERVICE_NAME" app_dir="$APP_DIR_NAME" host=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -i) key="$2"; shift 2 ;;
      --ref) ref="$2"; shift 2 ;;
      --port) port="$2"; shift 2 ;;
      --mesh-port) mesh_port="$2"; shift 2 ;;
      --user) target_user="$2"; shift 2 ;;
      --service) service="$2"; shift 2 ;;
      --app-dir) app_dir="$2"; shift 2 ;;
      -h | --help) sed -n '2,21p' "$0"; exit 0 ;;
      -*) die "未知参数 $1" ;;
      *) host="$1"; shift ;;
    esac
  done
  [ -n "$host" ] || die "用法：$0 [-i 私钥] [--ref git引用] [--port 端口] [--mesh-port 端口] [--user 用户名] [--service 服务名] [--app-dir 目录名] 用户@主机"
  local ssh_cmd=(ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
  [ -z "$key" ] || ssh_cmd+=(-i "$key")

  local root sha remote_user
  root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
  sha=$(git -C "$root" rev-parse --verify "$ref^{commit}") || die "找不到 ${ref}，先 git fetch origin"
  remote_user=$("${ssh_cmd[@]}" "$host" "id -un")
  log "部署 ${ref}（${sha:0:8}）→ ${host}${target_user:+（用户 $target_user）}，端口 $port${mesh_port:+，mesh $mesh_port}，服务 $service"

  local server_args=(--on-server --sha "$sha" --port "$port" --service "$service" --app-dir "$app_dir")
  [ -z "$mesh_port" ] || server_args+=(--mesh-port "$mesh_port")
  [ -z "$target_user" ] || server_args+=(--user "$target_user")

  local run_prefix="" target_home="~"
  if [ -n "$target_user" ] && [ "$remote_user" != "$target_user" ]; then
    local target_uid
    target_uid=$("${ssh_cmd[@]}" "$host" "id -u $(printf '%q' "$target_user")") || die "服务器上没有用户 $target_user"
    target_home=$("${ssh_cmd[@]}" "$host" "getent passwd $(printf '%q' "$target_user") | cut -d: -f6")
    run_prefix="sudo -H -u $(printf '%q' "$target_user") env XDG_RUNTIME_DIR=/run/user/$target_uid "
  fi

  # 服务器上已经是这个提交就不重传（脚本在服务器那头还会检查依赖和构建都在）
  local deployed
  deployed=$("${ssh_cmd[@]}" "$host" "${run_prefix}cat $target_home/$app_dir/.deployed-sha 2>/dev/null || true")
  if [ "$deployed" = "$sha" ]; then
    skip "服务器上已是 ${sha:0:8}，不重传代码"
  else
    log "推代码（git archive，只含已提交的文件，不含 GitHub 令牌）"
    git -C "$root" archive --format=tar "$sha" |
      "${ssh_cmd[@]}" "$host" "${run_prefix}sh -c 'rm -rf \"\$HOME/.$app_dir-incoming\" && mkdir -p \"\$HOME/.$app_dir-incoming\" && tar -x -C \"\$HOME/.$app_dir-incoming\"'"
  fi

  if [ -n "$run_prefix" ]; then
    "${ssh_cmd[@]}" "$host" bash -s -- --on-server --host-only --user "$target_user" --app-dir "$app_dir" <"$0"
  fi
  "${ssh_cmd[@]}" "$host" "${run_prefix}bash -s -- $(printf '%q ' "${server_args[@]}")" <"$0"
  log "完成。本机打开网页：ssh ${key:+-i $key }-N -L $port:127.0.0.1:$port ${host}，然后浏览器开 http://127.0.0.1:$port/"
}

if [ "${1:-}" = "--on-server" ]; then
  shift
  on_server "$@"
else
  on_local "$@"
fi
