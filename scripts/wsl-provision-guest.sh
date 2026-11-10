#!/usr/bin/env bash
# Windows 桌面版 WSL2 专用发行版（Fusa / Ubuntu 24.04）内部幂等准备与沙箱隔离自检脚本。
# 由宿主侧 fusa-wsl 库通过 `wsl.exe --distribution Fusa --user <root|fusa> --exec ...` 直接调用，不经 sh -c 拼接。
#
# 子命令：
#   --phase root               以 root 初始化 /etc/wsl.conf、普通用户 fusa（禁免密 sudo）、apt 依赖与 AppArmor bwrap 规则
#   --phase user               以普通用户 fusa 安装锁定且经 SHA256 校验的 Node 24、pnpm 官方包及固定目录结构
#   --self-test                运行 interop 关闭与 bubblewrap 拒写/放行隔离门禁，向 stdout 输出单行结构化 JSON
#   --vendors-json [--app-dir] 按 src/vendors 注册表（scripts/print-vendors.ts）动态输出各厂商安装与登录引导 JSON
#   --print-constants          输出脚本锁定的运行时版本与校验值常量 JSON

set -euo pipefail

# ───────────── 集中可调与锁定常量（测试环境可通过 FUSA_* 覆盖隔离路径）─────────────
DEFAULT_NODE_VERSION="24.22.2"
DEFAULT_NODE_LINUX_X64_SHA256="48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75"
DEFAULT_PNPM_VERSION="10.34.5"
# registry.npmjs.org/pnpm/-/pnpm-10.34.5.tgz 的 SHA256（该包 dist.integrity 的 sha512 已核对一致；pnpm 无任何依赖，装它不再联网拉别的包）
DEFAULT_PNPM_TARBALL_SHA256="ccb5c479cab1b00621325bfe7d4c9a8a8031e7a525d7249e275ecbec81b08db2"

FUSA_USER="${FUSA_WSL_USER:-fusa}"
FUSA_HOME="${FUSA_WSL_HOME:-/home/${FUSA_USER}}"
WSL_CONF_PATH="${FUSA_WSL_CONF_PATH:-/etc/wsl.conf}"
SUDOERS_FILE="${FUSA_SUDOERS_FILE:-/etc/sudoers}"
SUDOERS_DIR="${FUSA_SUDOERS_DIR:-/etc/sudoers.d}"
APPARMOR_DIR="${FUSA_APPARMOR_DIR:-/etc/apparmor.d}"
APPARMOR_SECURITYFS="${FUSA_APPARMOR_SECURITYFS:-/sys/kernel/security/apparmor}"
BINFMT_DIR="${FUSA_BINFMT_DIR:-/proc/sys/fs/binfmt_misc}"
MOUNTINFO_PATH="${FUSA_MOUNTINFO_PATH:-/proc/self/mountinfo}"
EFFECTIVE_UID="${FUSA_EFFECTIVE_UID:-$(id -u)}"

NODE_VERSION="${FUSA_NODE_VERSION:-${DEFAULT_NODE_VERSION}}"
NODE_LINUX_X64_SHA256="${FUSA_NODE_SHA256:-${DEFAULT_NODE_LINUX_X64_SHA256}}"
NODE_DIST_BASE_URL="${FUSA_NODE_DIST_BASE_URL:-https://nodejs.org/dist/v${NODE_VERSION}}"
PNPM_VERSION="${FUSA_PNPM_VERSION:-${DEFAULT_PNPM_VERSION}}"
PNPM_TARBALL_SHA256="${FUSA_PNPM_SHA256:-${DEFAULT_PNPM_TARBALL_SHA256}}"
PNPM_REGISTRY_BASE_URL="${FUSA_PNPM_REGISTRY_BASE_URL:-https://registry.npmjs.org/pnpm/-}"

FUSA_SHARE_DIR="${FUSA_HOME}/.local/share/fusa"
NODE_INSTALL_DIR="${FUSA_SHARE_DIR}/node"
PNPM_PREFIX_DIR="${FUSA_SHARE_DIR}/pnpm"
RELEASES_DIR="${FUSA_SHARE_DIR}/releases"
PROJECTS_DIR="${FUSA_HOME}/projects"
LOCAL_BIN_DIR="${FUSA_HOME}/.local/bin"

APT_PACKAGES=(git procps curl ca-certificates xz-utils bubblewrap socat)

log() { printf '[fusa-wsl-guest] %s\n' "$*" >&2; }
die() { printf '[fusa-wsl-guest] 错误：%s\n' "$*" >&2; exit 1; }

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# 下载到 dest 并校验 SHA256，下载或校验失败都删掉 dest 并退出。
download_verified() {
  local url="$1" expected="$2" dest="$3" actual
  curl -fsSL -o "$dest" "$url" || { rm -f "$dest"; die "下载失败：${url}"; }
  expected=$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')
  actual=$(compute_sha256 "$dest")
  if [ "$actual" != "$expected" ]; then
    rm -f "$dest"
    die "SHA256 校验失败：${url}（期望 ${expected}，实际 ${actual}）"
  fi
}

compute_sha256() {
  local file="$1" raw=""
  if command -v sha256sum >/dev/null 2>&1; then
    raw=$(sha256sum "$file" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    raw=$(shasum -a 256 "$file" | awk '{print $1}')
  else
    die "缺少 sha256sum 或 shasum 校验工具"
  fi
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]'
}

# ═══════════════════════ root 初始化阶段 ═══════════════════════
wsl_conf_text() {
  cat <<EOF
[interop]
enabled=false
appendWindowsPath=false

[automount]
enabled=false

[user]
default=${FUSA_USER}
EOF
}

apparmor_bwrap_text() {
  cat <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
}

phase_root() {
  [ "$EFFECTIVE_UID" = "0" ] || die "--phase root 必须以 root (uid=0) 执行"

  # 1) 幂等写入 /etc/wsl.conf（关闭 interop、Windows PATH 注入与磁盘自动挂载，默认登录普通用户）
  mkdir -p "$(dirname "$WSL_CONF_PATH")"
  local expected_conf
  expected_conf="$(wsl_conf_text)"$'\n'
  if [ ! -f "$WSL_CONF_PATH" ] || [ "$(cat "$WSL_CONF_PATH")"$'\n' != "$expected_conf" ]; then
    log "写入 ${WSL_CONF_PATH}"
    printf '%s' "$expected_conf" > "$WSL_CONF_PATH"
    chmod 0644 "$WSL_CONF_PATH"
  else
    log "跳过：${WSL_CONF_PATH} 已是目标隔离配置"
  fi

  # 2) 幂等创建普通用户 fusa，严禁配置免密码 sudo
  if ! id -u "$FUSA_USER" >/dev/null 2>&1; then
    log "创建普通用户 ${FUSA_USER}"
    useradd -m -s /bin/bash "$FUSA_USER"
  else
    log "跳过：普通用户 ${FUSA_USER} 已存在"
  fi
  mkdir -p "$FUSA_HOME"
  chown "${FUSA_USER}:${FUSA_USER}" "$FUSA_HOME"

  # 清理可能残留的同名 sudoers 片段并确保未加入免密提权链路
  if [ -f "${SUDOERS_DIR}/${FUSA_USER}" ]; then
    log "移除残留的 ${SUDOERS_DIR}/${FUSA_USER}"
    rm -f "${SUDOERS_DIR}/${FUSA_USER}"
  fi
  if command -v gpasswd >/dev/null 2>&1; then
    gpasswd -d "$FUSA_USER" sudo >/dev/null 2>&1 || true
  fi
  local sudo_check_file
  for sudo_check_file in "$SUDOERS_FILE" "${SUDOERS_DIR}"/*; do
    [ -f "$sudo_check_file" ] || continue
    if grep -Eq "^[[:space:]]*${FUSA_USER}[[:space:]].*NOPASSWD" "$sudo_check_file" 2>/dev/null; then
      die "检测到 ${sudo_check_file} 中为 ${FUSA_USER} 配置了免密码 sudo（违反安全隔离要求）"
    fi
  done

  # 3) 幂等安装系统依赖
  local missing=() pkg
  for pkg in "${APT_PACKAGES[@]}"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    log "安装系统依赖：${missing[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends "${missing[@]}"
  else
    log "跳过：系统依赖均已安装"
  fi

  # 4) 对齐 scripts/linux-sandbox-setup.sh 检查 userns 与 AppArmor profile（不假设 WSL 内核一定开启了 AppArmor）
  if [ -f /proc/sys/kernel/unprivileged_userns_clone ]; then
    local userns_clone
    userns_clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo "1")
    if [ "$userns_clone" = "0" ]; then
      die "内核禁用了非特权 userns（kernel.unprivileged_userns_clone=0），bubblewrap 无法建立隔离命名空间"
    fi
  fi

  if [ -d "$APPARMOR_DIR" ]; then
    local bwrap_profile="${APPARMOR_DIR}/bwrap" existing
    for existing in "${APPARMOR_DIR}"/*; do
      [ -f "$existing" ] || continue
      [ "$existing" = "$bwrap_profile" ] && continue
      if grep -q "/usr/bin/bwrap" "$existing" 2>/dev/null; then
        log "警告：${existing} 也包含 /usr/bin/bwrap，可能与 ${bwrap_profile} 冲突"
      fi
    done

    local expected_profile
    expected_profile="$(apparmor_bwrap_text)"$'\n'
    if [ ! -f "$bwrap_profile" ] || [ "$(cat "$bwrap_profile")"$'\n' != "$expected_profile" ]; then
      log "写入 AppArmor 规则 ${bwrap_profile}"
      printf '%s' "$expected_profile" > "$bwrap_profile"
      chmod 0644 "$bwrap_profile"
      if command -v apparmor_parser >/dev/null 2>&1 && [ -d "$APPARMOR_SECURITYFS" ]; then
        apparmor_parser -r "$bwrap_profile"
      fi
    else
      log "跳过：AppArmor 规则 ${bwrap_profile} 未变化"
    fi
  fi
}

# ═══════════════════════ 普通用户 fusa 初始化阶段 ═══════════════════════
link_node_bins() {
  mkdir -p "$LOCAL_BIN_DIR"
  ln -sfn "${NODE_INSTALL_DIR}/bin/node" "${LOCAL_BIN_DIR}/node"
  ln -sfn "${NODE_INSTALL_DIR}/bin/npm" "${LOCAL_BIN_DIR}/npm"
  ln -sfn "${NODE_INSTALL_DIR}/bin/npx" "${LOCAL_BIN_DIR}/npx"
}

phase_user() {
  [ "$EFFECTIVE_UID" != "0" ] || die "--phase user 必须以普通用户执行，禁止使用 root"

  mkdir -p "$PROJECTS_DIR" "$RELEASES_DIR" "$FUSA_SHARE_DIR" "$LOCAL_BIN_DIR"

  # 1) 安装锁定版本且经官方 SHA256 校验的 Linux x64 Node 24 预编译包
  local have_node=""
  if [ -x "${NODE_INSTALL_DIR}/bin/node" ]; then
    have_node=$("${NODE_INSTALL_DIR}/bin/node" -v 2>/dev/null || true)
  fi

  if [ "$have_node" = "v${NODE_VERSION}" ]; then
    log "跳过：Node 已是锁定版本 ${have_node}"
    link_node_bins
  else
    local arch="${FUSA_NODE_ARCH_OVERRIDE:-$(uname -m)}"
    [ "$arch" = "x86_64" ] || die "当前仅支持 Linux x86_64 架构（检测到：${arch}）"

    local tarball="node-v${NODE_VERSION}-linux-x64.tar.xz"
    local url="${NODE_DIST_BASE_URL}/${tarball}"
    local tmp_dir staging_dir
    tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/fusa-node-dl.XXXXXX")
    staging_dir="${FUSA_SHARE_DIR}/.node-staging.$$"
    rm -rf "$staging_dir"

    log "下载 Node 预编译包：${url}"
    if ! curl -fsSL -o "${tmp_dir}/${tarball}" "$url"; then
      rm -rf "$tmp_dir"
      die "下载 Node 失败：${url}"
    fi

    local expected_sha actual_sha
    expected_sha=$(printf '%s' "$NODE_LINUX_X64_SHA256" | tr '[:upper:]' '[:lower:]')
    actual_sha=$(compute_sha256 "${tmp_dir}/${tarball}")
    if [ "$actual_sha" != "$expected_sha" ]; then
      rm -rf "$tmp_dir"
      die "Node 预编译包 SHA256 校验失败（期望 ${expected_sha}，实际 ${actual_sha}）"
    fi

    mkdir -p "$staging_dir"
    if ! tar -xJf "${tmp_dir}/${tarball}" -C "$staging_dir" --strip-components=1; then
      rm -rf "$tmp_dir" "$staging_dir"
      die "解压 Node 预编译包失败"
    fi
    rm -rf "$tmp_dir"

    local unpacked_ver
    unpacked_ver=$("${staging_dir}/bin/node" -v 2>/dev/null || true)
    if [ "$unpacked_ver" != "v${NODE_VERSION}" ]; then
      rm -rf "$staging_dir"
      die "解压后的 Node 版本异常（期望 v${NODE_VERSION}，实际 ${unpacked_ver}）"
    fi

    rm -rf "$NODE_INSTALL_DIR"
    mv "$staging_dir" "$NODE_INSTALL_DIR"
    link_node_bins
    log "Node v${NODE_VERSION} 安装完成"
  fi

  export PATH="${NODE_INSTALL_DIR}/bin:${PNPM_PREFIX_DIR}/bin:${LOCAL_BIN_DIR}:${PATH}"

  # 2) 安装锁定版本 pnpm（与仓库 package.json packageManager 保持一致，不依赖系统 Corepack）
  local have_pnpm=""
  if [ -x "${PNPM_PREFIX_DIR}/bin/pnpm" ]; then
    have_pnpm=$("${PNPM_PREFIX_DIR}/bin/pnpm" -v 2>/dev/null || true)
  fi

  if [ "$have_pnpm" = "$PNPM_VERSION" ]; then
    log "跳过：pnpm 已是锁定版本 ${have_pnpm}"
    ln -sfn "${PNPM_PREFIX_DIR}/bin/pnpm" "${LOCAL_BIN_DIR}/pnpm"
  else
    log "安装 pnpm@${PNPM_VERSION}"
    mkdir -p "$PNPM_PREFIX_DIR"
    # 先下载官方 tarball 校验锁定的 SHA256，再让 npm 从本地文件安装（不按版本号去 registry 解析）
    local pnpm_tmp pnpm_tgz
    pnpm_tmp=$(mktemp -d "${TMPDIR:-/tmp}/fusa-pnpm-dl.XXXXXX")
    pnpm_tgz="${pnpm_tmp}/pnpm-${PNPM_VERSION}.tgz"
    ( download_verified "${PNPM_REGISTRY_BASE_URL}/pnpm-${PNPM_VERSION}.tgz" "$PNPM_TARBALL_SHA256" "$pnpm_tgz" ) \
      || { rm -rf "$pnpm_tmp"; die "pnpm 官方包下载或校验未通过"; }
    if ! "${NODE_INSTALL_DIR}/bin/npm" install --global --prefix "$PNPM_PREFIX_DIR" "$pnpm_tgz" \
      --no-fund --no-audit --loglevel=error; then
      rm -rf "$pnpm_tmp"
      die "安装 pnpm 失败"
    fi
    rm -rf "$pnpm_tmp"
    ln -sfn "${PNPM_PREFIX_DIR}/bin/pnpm" "${LOCAL_BIN_DIR}/pnpm"
    have_pnpm=$("${LOCAL_BIN_DIR}/pnpm" -v 2>/dev/null || true)
    [ "$have_pnpm" = "$PNPM_VERSION" ] || die "安装后的 pnpm 版本异常（期望 ${PNPM_VERSION}，实际 ${have_pnpm}）"
  fi
}

# ═══════════════════════ 隔离自检门禁（--self-test）═══════════════════════
run_self_test() {
  local ok_non_root=true
  local ok_no_sudo=true
  local ok_interop=true
  local ok_win_path=true
  local ok_bwrap_probe=true
  local ok_bwrap_write=true

  local failure_codes=()
  local failure_details=()
  local primary_code=""
  local primary_msg="WSL2 隔离与 bubblewrap 沙箱自检通过"

  record_failure() {
    local code="$1" msg="$2" detail="$3"
    failure_codes+=("$code")
    failure_details+=("$detail")
    if [ -z "$primary_code" ]; then
      primary_code="$code"
      primary_msg="$msg"
    fi
  }

  # 0a) 普通用户身份检查
  if [ "$EFFECTIVE_UID" = "0" ]; then
    ok_non_root=false
    record_failure "running_as_root" "后台与自检必须以普通用户运行，不能使用 root" "effective uid 为 0"
  fi

  # 0b) 禁止免密码 sudo
  local sudo_bin="${FUSA_SUDO_BIN:-sudo}"
  if command -v "$sudo_bin" >/dev/null 2>&1; then
    if "$sudo_bin" -n true </dev/null >/dev/null 2>&1; then
      ok_no_sudo=false
      record_failure "sudo_nopasswd_enabled" "检测到普通用户拥有免密码 sudo，存在沙箱提权风险" "${sudo_bin} -n true 返回 0"
    fi
  fi

  # 1a) 检查 /proc/sys/fs/binfmt_misc/WSLInterop* 已关闭
  if [ -d "$BINFMT_DIR" ]; then
    local interop_entry first_line
    for interop_entry in "${BINFMT_DIR}"/WSLInterop*; do
      [ -e "$interop_entry" ] || continue
      first_line=$(head -n 1 "$interop_entry" 2>/dev/null || true)
      if [ "$first_line" = "enabled" ]; then
        ok_interop=false
        record_failure "interop_binfmt_enabled" "WSL interop 仍处于开启状态，Worker 可能调用 Windows 程序绕过沙箱" "${interop_entry} 状态为 enabled"
        break
      fi
    done
  fi

  # 1b) 检查无法调用 Windows 侧进程且不存在存活的 WSL_INTEROP socket
  if [ -n "${WSL_INTEROP:-}" ] && [ -e "${WSL_INTEROP}" ]; then
    ok_interop=false
    record_failure "interop_process_launchable" "检测到存活的 WSL_INTEROP 套接字，Windows 互操作未彻底关闭" "WSL_INTEROP=${WSL_INTEROP} 仍存在"
  else
    local win_probe="${FUSA_SELF_TEST_WIN_CMD:-cmd.exe}"
    if command -v "$win_probe" >/dev/null 2>&1 && "$win_probe" /c exit 0 </dev/null >/dev/null 2>&1; then
      ok_interop=false
      record_failure "interop_process_launchable" "仍可直接启动 Windows 侧可执行程序，沙箱隔离未生效" "成功执行了 ${win_probe}"
    fi
  fi

  # 1c) 检查 PATH 未混入 /mnt/<盘符> 且未自动挂载 drvfs Windows 磁盘
  local IFS_SAVED="$IFS"
  IFS=':'
  local path_seg
  for path_seg in ${PATH:-}; do
    case "$path_seg" in
      /mnt/[a-zA-Z]|/mnt/[a-zA-Z]/*)
        ok_win_path=false
        record_failure "windows_path_leaked" "PATH 环境变量中仍包含 Windows 磁盘路径" "检测到 PATH 项：${path_seg}"
        break
        ;;
    esac
  done
  IFS="$IFS_SAVED"

  if [ -r "$MOUNTINFO_PATH" ]; then
    if awk -F ' - ' 'NF >= 2 && ($2 ~ /^drvfs / || $2 ~ /^[^ ]+ drvfs / || $2 ~ /(^|[,;])aname=drvfs($|[,; ])/) { found=1 } END { exit(found ? 0 : 1) }' "$MOUNTINFO_PATH"; then
      ok_win_path=false
      record_failure "windows_drvfs_mounted" "检测到发行版内仍挂载了 Windows drvfs 磁盘，请确认 /etc/wsl.conf automount=false 已重启生效" "${MOUNTINFO_PATH} 包含 drvfs 挂载"
    fi
  fi

  # 2a) 检查 bubblewrap 可正常启动隔离命名空间
  local bwrap_bin="${FUSA_BWRAP_BIN:-bwrap}"
  if ! command -v "$bwrap_bin" >/dev/null 2>&1; then
    ok_bwrap_probe=false
    ok_bwrap_write=false
    record_failure "bwrap_unavailable" "未安装 bubblewrap (bwrap)，无法启动 Worker OS 沙箱" "找不到可执行文件 ${bwrap_bin}"
  else
    local probe_err=""
    if ! probe_err=$("$bwrap_bin" --unshare-user --disable-userns --unshare-pid \
      --bind / / --proc /proc --dev-bind /dev /dev --perms 0700 --tmpfs "/run/user/${EFFECTIVE_UID}" \
      -- /bin/true 2>&1); then
      ok_bwrap_probe=false
      ok_bwrap_write=false
      record_failure "bwrap_unavailable" "bubblewrap 无法建立非特权隔离沙箱，已禁止派发 Worker" "${probe_err:-bwrap 探测返回非零退出码}"
    fi
  fi

  # 2b) 真实验证 bubblewrap 拒写 ~/.agent-hub/state 数据目录、同时放行临时工作目录
  if [ "$ok_bwrap_probe" = true ]; then
    local data_dir="${FUSA_HOME}/.agent-hub"
    local state_dir="${data_dir}/state"
    mkdir -p "$state_dir"
    local work_dir denied_probe allowed_probe
    work_dir=$(mktemp -d "${data_dir}/.self-test-work.XXXXXX")
    denied_probe="${state_dir}/.fusa-self-test-denied.$$"
    allowed_probe="${work_dir}/allowed.txt"
    rm -f "$denied_probe"

    local extra_mask_args=() wsl_dir
    for wsl_dir in /run/WSL /mnt/wsl /mnt/wslg; do
      if [ -e "$wsl_dir" ]; then
        extra_mask_args+=(--perms 0700 --tmpfs "$wsl_dir")
      fi
    done

    local guard_rc=0
    "$bwrap_bin" --unshare-user --disable-userns --unshare-pid \
      --bind / / --proc /proc --dev-bind /dev /dev --perms 0700 --tmpfs "/run/user/${EFFECTIVE_UID}" \
      ${extra_mask_args[@]+"${extra_mask_args[@]}"} \
      --ro-bind "$data_dir" "$data_dir" \
      --bind "$work_dir" "$work_dir" \
      -- /bin/sh -c 'if (: > "$1") 2>/dev/null; then exit 11; fi; printf ok > "$2" || exit 12' _ \
      "$denied_probe" "$allowed_probe" >/dev/null 2>&1 || guard_rc=$?

    local allowed_content=""
    if [ -f "$allowed_probe" ]; then
      allowed_content=$(cat "$allowed_probe" 2>/dev/null || true)
    fi

    if [ "$guard_rc" -ne 0 ] || [ -e "$denied_probe" ] || [ "$allowed_content" != "ok" ]; then
      ok_bwrap_write=false
      rm -rf "$work_dir" "$denied_probe"
      record_failure "bwrap_write_guard_failed" "bubblewrap 写范围隔离自检失败（未能拒写 state 目录或未能放行工作目录）" "guard_rc=${guard_rc}"
    else
      rm -rf "$work_dir" "$denied_probe"
    fi
  fi

  local overall_ok=true
  if [ "${#failure_codes[@]}" -gt 0 ]; then
    overall_ok=false
  fi

  local failures_json="" i
  for ((i = 0; i < ${#failure_codes[@]}; i++)); do
    local item
    item=$(printf '{"code":"%s","detail":"%s"}' \
      "$(json_escape "${failure_codes[$i]}")" \
      "$(json_escape "${failure_details[$i]}")")
    if [ -z "$failures_json" ]; then
      failures_json="$item"
    else
      failures_json="${failures_json},${item}"
    fi
  done

  local code_field="null"
  if [ -n "$primary_code" ]; then
    code_field="\"$(json_escape "$primary_code")\""
  fi

  printf '{"ok":%s,"worker_sandbox_ready":%s,"error_code":%s,"message":"%s","checks":{"non_root":%s,"no_passwordless_sudo":%s,"interop_disabled":%s,"windows_path_clean":%s,"bwrap_probe":%s,"bwrap_write_guard":%s},"failures":[%s]}\n' \
    "$overall_ok" \
    "$overall_ok" \
    "$code_field" \
    "$(json_escape "$primary_msg")" \
    "$ok_non_root" \
    "$ok_no_sudo" \
    "$ok_interop" \
    "$ok_win_path" \
    "$ok_bwrap_probe" \
    "$ok_bwrap_write" \
    "$failures_json"

  [ "$overall_ok" = true ]
}

# ═══════════════════════ 动态读取厂商安装与登录引导（--vendors-json）═══════════════════════
print_vendors_json() {
  local app_dir="${1:-${FUSA_APP_DIR:-}}"
  if [ -z "$app_dir" ]; then
    local script_dir
    script_dir=$(cd "$(dirname "$0")" && pwd)
    app_dir=$(cd "${script_dir}/.." && pwd)
  fi

  local print_script="${app_dir}/scripts/print-vendors.ts"
  [ -f "$print_script" ] || die "找不到厂商注册表读取脚本：${print_script}"

  export PATH="${LOCAL_BIN_DIR}:${NODE_INSTALL_DIR}/bin:${PNPM_PREFIX_DIR}/bin:${PATH}"

  local node_bin="${FUSA_NODE_BIN_OVERRIDE:-}"
  if [ -z "$node_bin" ]; then
    if [ -x "${NODE_INSTALL_DIR}/bin/node" ]; then
      node_bin="${NODE_INSTALL_DIR}/bin/node"
    elif command -v node >/dev/null 2>&1; then
      node_bin=$(command -v node)
    else
      die "找不到 Node 运行时，无法读取厂商注册表"
    fi
  fi

  local tsv_output
  tsv_output=$("$node_bin" "$print_script") || die "执行 ${print_script} 失败"

  local items_json="" line id cmd install_cmd login_cmd bin_path installed bin_json
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    IFS=$'\t' read -r id cmd install_cmd login_cmd <<< "$line"
    bin_path=$(command -v "$cmd" 2>/dev/null || true)
    if [ -n "$bin_path" ]; then
      installed=true
      bin_json="\"$(json_escape "$bin_path")\""
    else
      installed=false
      bin_json="null"
    fi
    local entry
    entry=$(printf '{"id":"%s","command":"%s","install_command":"%s","login_command":"%s","installed":%s,"binary_path":%s}' \
      "$(json_escape "$id")" \
      "$(json_escape "$cmd")" \
      "$(json_escape "$install_cmd")" \
      "$(json_escape "$login_cmd")" \
      "$installed" \
      "$bin_json")
    if [ -z "$items_json" ]; then
      items_json="$entry"
    else
      items_json="${items_json},${entry}"
    fi
  done <<< "$tsv_output"

  printf '[%s]\n' "$items_json"
}

print_constants() {
  printf '{"distro_user":"%s","node_version":"%s","node_linux_x64_sha256":"%s","pnpm_version":"%s","pnpm_tarball_sha256":"%s"}\n' \
    "$(json_escape "$FUSA_USER")" \
    "$(json_escape "$NODE_VERSION")" \
    "$(json_escape "$NODE_LINUX_X64_SHA256")" \
    "$(json_escape "$PNPM_VERSION")" \
    "$(json_escape "$PNPM_TARBALL_SHA256")"
}

# ═══════════════════════ 参数分发 ═══════════════════════
main() {
  [ $# -gt 0 ] || die "用法：$0 <--phase root|--phase user|--self-test|--vendors-json [--app-dir 目录]|--print-constants>"
  case "$1" in
    --phase)
      [ $# -ge 2 ] || die "--phase 需要指定 root 或 user"
      case "$2" in
        root) phase_root ;;
        user) phase_user ;;
        *) die "未知的 --phase 参数：$2（仅支持 root 或 user）" ;;
      esac
      ;;
    --self-test)
      run_self_test
      ;;
    --vendors-json)
      shift
      local app_dir=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --app-dir)
            [ $# -ge 2 ] || die "--app-dir 缺少目录参数"
            app_dir="$2"
            shift 2
            ;;
          *)
            die "未知参数：$1"
            ;;
        esac
      done
      print_vendors_json "$app_dir"
      ;;
    --print-constants)
      print_constants
      ;;
    *)
      die "未知子命令：$1"
      ;;
  esac
}

main "$@"
