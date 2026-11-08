#!/usr/bin/env bash
# Linux (Ubuntu 24.04+) Worker 沙箱一次性配置脚本（幂等，见 docs/linux-sandbox-design.md 第 6 节）：
# 1. 确保已安装 bubblewrap 与 socat（只读 claude 自带沙箱需要 socat）；
# 2. 写入 /etc/apparmor.d/bwrap 并加载 AppArmor profile，放行 /usr/bin/bwrap 建非特权 userns；
# 3. 以普通用户身份跑一次 bwrap 探测命令验证沙箱可用。
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "scripts/linux-sandbox-setup.sh 仅用于 Linux" >&2
  exit 1
fi

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# 1) 缺 bubblewrap 或 socat 时自动安装
if ! command -v bwrap >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  run_root apt-get update -y
  run_root apt-get install -y bubblewrap socat
fi

# 2) AppArmor profile：给 /usr/bin/bwrap 放行 userns
if [ -d /etc/apparmor.d ]; then
  for existing in /etc/apparmor.d/*; do
    [ -f "$existing" ] || continue
    [ "$existing" = "/etc/apparmor.d/bwrap" ] && continue
    if grep -q "/usr/bin/bwrap" "$existing" 2>/dev/null; then
      echo "警告：$existing 中也包含 /usr/bin/bwrap，可能与 /etc/apparmor.d/bwrap 冲突" >&2
    fi
  done

  run_root tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF

  if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then
    run_root apparmor_parser -r /etc/apparmor.d/bwrap
  fi
fi

# 3) 验证 bwrap 沙箱（若通过 sudo 调用则切回原普通用户验证非特权 userns）
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  TARGET_UID="$(id -u "$SUDO_USER")"
  sudo -u "$SUDO_USER" bwrap --unshare-user --disable-userns --unshare-pid --proc /proc \
    --bind / / --dev-bind /dev /dev --perms 0700 --tmpfs "/run/user/${TARGET_UID}" -- /bin/true
else
  bwrap --unshare-user --disable-userns --unshare-pid --proc /proc \
    --bind / / --dev-bind /dev /dev --perms 0700 --tmpfs "/run/user/$(id -u)" -- /bin/true
fi
echo "bwrap-ok"
