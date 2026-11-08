#!/usr/bin/env bash
# ssh 隧道在中心（东京）上要 root 的那一半（docs/hub-tunnel-design.md 第 3、7 节）。只做三件事：
#   1. 隧道专用系统用户 agenthub-tunnel（shell 是 nologin、没有家目录）；
#   2. sshd 片段 /etc/ssh/sshd_config.d/agent-hub-tunnel.conf（Match User，第二层兜底）；
#   3. 钥匙行 /etc/ssh/agent-hub-tunnel/authorized_keys（root 所有，隧道用户改不了），一台设备一行，只能 -R 自己的槽位端口、-L 到设备入口。
#   删设备时删钥匙行，并结束这台现存的 ssh 会话（删钥匙行不会断已建立的连接）。
# 槽位端口、邀请码归守护进程管，这里只照参数写。一般不直接跑，由隧道命令（src/tunnel/）用 sudo -n 调：
#   tunnel-sshd.sh add-key --name <设备名> --port <槽位端口> --entry-port <设备入口端口> --pubkey "<ssh-ed25519 公钥>" [--admin-user <管理员>]
#   tunnel-sshd.sh remove-key --name <设备名>
# 重复跑收敛：按现状比对，只补差异（已经对的不动）；写了片段还没 reload 就中断，再跑一次会补上 reload。
# 改 sshd 片段时：改前、改后各跑一次 sshd -T 看管理员用户的实际配置，变了就撤回、报错；sshd -t 校验过了才 reload。
# 容器里的验收：scripts/verify-tunnel-sshd.sh。

set -euo pipefail
umask 022

# ───────────── 可调的值（集中在这里；改了要同时改方案第 3 节和 src/shared/tunnel.ts 的 TUNNEL_SSH_USER）─────────────
TUNNEL_USER=agenthub-tunnel
KEYS_DIR=/etc/ssh/agent-hub-tunnel
KEYS_FILE=$KEYS_DIR/authorized_keys
SNIPPET=/etc/ssh/sshd_config.d/agent-hub-tunnel.conf
# 写了片段、还没 reload 成功：有这个文件。下次跑看到它就补 reload
RELOAD_PENDING=$KEYS_DIR/.reload-pending
NOLOGIN=/usr/sbin/nologin
SSHD=/usr/sbin/sshd
# 东京清掉死连接：15 秒一次、3 次没回（和连入方 ServerAlive 一样，src/shared/limits.ts 的 TUNNEL_ALIVE_*）
CLIENT_ALIVE_INTERVAL=15
CLIENT_ALIVE_COUNT_MAX=3
# 槽位端口的范围（和 src/shared/limits.ts 的 TUNNEL_FIRST_SLOT_PORT / TUNNEL_LAST_SLOT_PORT 一样）：删设备时只在这一段里找没有钥匙行的会话
SLOT_PORT_MIN=4401
SLOT_PORT_MAX=4499
# sshd -T 比对管理员用户时假设的连接（只用来选 Match 块，不会真的连）
PROBE_HOST=x
PROBE_ADDR=203.0.113.1

log() { printf '[tunnel-sshd] %s\n' "$*" >&2; }
skip() { printf '[tunnel-sshd] 不动：%s\n' "$*" >&2; }
die() { printf '[tunnel-sshd] 失败：%s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '8,9p' "$0" | sed 's/^#   //' >&2
  exit 2
}

valid_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# ───────────── 1. 隧道用户 ─────────────
ensure_user() {
  if getent passwd "$TUNNEL_USER" >/dev/null; then
    local shell
    shell=$(getent passwd "$TUNNEL_USER" | cut -d: -f7)
    if [ "$shell" = "$NOLOGIN" ]; then skip "用户 $TUNNEL_USER 已有"; else usermod -s "$NOLOGIN" "$TUNNEL_USER"; log "用户 $TUNNEL_USER 的 shell 改回 $NOLOGIN"; fi
  else
    useradd --system --no-create-home --home-dir /nonexistent --shell "$NOLOGIN" "$TUNNEL_USER"
    log "建了用户 $TUNNEL_USER"
  fi
  # 密码字段：useradd 给的是 !（锁定），UsePAM no 时 OpenSSH 连公钥登录也拒；改成 *（没有密码，也不算锁定）
  if [ "$(getent shadow "$TUNNEL_USER" | cut -d: -f2)" != "*" ]; then usermod -p '*' "$TUNNEL_USER"; log "用户 $TUNNEL_USER 的密码字段改成 *"; fi
}

# ───────────── 2. sshd 片段 ─────────────
snippet_text() {
  local entry_port="$1"
  cat <<EOF
# agent-hub ssh 隧道（docs/hub-tunnel-design.md 第 3 节）。scripts/tunnel-sshd.sh 生成，手改会被改回。
Match User $TUNNEL_USER
  AuthorizedKeysFile $KEYS_FILE
  AuthorizedKeysCommand none
  PubkeyAuthentication yes
  AuthenticationMethods publickey
  AllowTcpForwarding yes
  AllowStreamLocalForwarding no
  GatewayPorts no
  PermitOpen 127.0.0.1:$entry_port
  PermitTTY no
  X11Forwarding no
  AllowAgentForwarding no
  PermitTunnel no
  PermitUserRC no
  ForceCommand $NOLOGIN
  ClientAliveInterval $CLIENT_ALIVE_INTERVAL
  ClientAliveCountMax $CLIENT_ALIVE_COUNT_MAX
EOF
}

# sshd -t / -T 要有特权分离目录（sshd 没起过时可能还没有）
ensure_privsep_dir() { [ -d /run/sshd ] || install -d -m 0755 /run/sshd; }

effective_config() { "$SSHD" -T -C "user=$1,host=$PROBE_HOST,addr=$PROBE_ADDR"; }

reload_sshd() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    # 没在跑（Ubuntu 24.04 按需起 ssh.service）就什么都不做：下次起来读新配置
    systemctl try-reload-or-restart ssh.service
    log "已让 sshd 重读配置（systemctl try-reload-or-restart ssh）"
  elif [ -s /run/sshd.pid ] && kill -0 "$(cat /run/sshd.pid)" 2>/dev/null; then
    kill -HUP "$(cat /run/sshd.pid)"
    log "已让 sshd 重读配置（SIGHUP）"
  else
    log "sshd 没在跑：下次启动时读新配置"
  fi
}

# 撤回片段：恢复改之前的样子（原来没有就删掉）
restore_snippet() {
  local backup="$1"
  if [ -n "$backup" ]; then cp -p "$backup" "$SNIPPET"; else rm -f "$SNIPPET"; fi
}

ensure_snippet() {
  local entry_port="$1" desired current=""
  desired=$(snippet_text "$entry_port")
  [ -f "$SNIPPET" ] && current=$(cat "$SNIPPET")
  if [ "$current" = "$desired" ] && [ ! -e "$RELOAD_PENDING" ]; then skip "sshd 片段已是最新"; return; fi
  ensure_privsep_dir
  if [ "$current" != "$desired" ]; then
    local before after backup="" tmp
    before=$(effective_config "$ADMIN_USER") || die "改之前 sshd -T 就失败了，先修好现有的 sshd 配置"
    if [ -f "$SNIPPET" ]; then backup=$(mktemp); cp -p "$SNIPPET" "$backup"; fi
    : >"$RELOAD_PENDING"
    tmp=$(mktemp "$SNIPPET.XXXXXX")
    printf '%s\n' "$desired" >"$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$SNIPPET"
    if ! "$SSHD" -t; then
      restore_snippet "$backup"
      die "sshd -t 校验不过，已撤回片段"
    fi
    after=$(effective_config "$ADMIN_USER")
    if [ "$before" != "$after" ]; then
      restore_snippet "$backup"
      diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
      die "片段改变了管理员用户 $ADMIN_USER 的 sshd 配置（上面是差异），已撤回"
    fi
    # 片段真的作用到了隧道用户上（主配置要 Include sshd_config.d，前面没有别的 Match 抢先）
    local tunnel_cfg want
    tunnel_cfg=$(effective_config "$TUNNEL_USER")
    for want in "forcecommand $NOLOGIN" "authorizedkeysfile $KEYS_FILE" "allowstreamlocalforwarding no" "permittty no" "gatewayports no" "permitopen 127.0.0.1:$entry_port"; do
      if ! grep -qxF "$want" <<<"$tunnel_cfg"; then
        restore_snippet "$backup"
        die "片段没作用到 $TUNNEL_USER 上（sshd -T 里没有“$want”）：sshd_config 要 Include /etc/ssh/sshd_config.d/*.conf，已撤回"
      fi
    done
    log "写了 sshd 片段 $SNIPPET（管理员用户 $ADMIN_USER 的配置没变）"
  else
    "$SSHD" -t || die "sshd -t 校验不过"
    log "片段上次写了还没 reload，补上"
  fi
  reload_sshd
  rm -f "$RELOAD_PENDING"
}

# ───────────── 3. 钥匙行 ─────────────
ensure_keys_dir() {
  if [ -d "$KEYS_DIR" ] && [ "$(stat -c '%U:%G %a' "$KEYS_DIR")" = "root:root 755" ]; then return; fi
  install -d -m 0755 -o root -g root "$KEYS_DIR"
  log "建了 $KEYS_DIR"
}

# 钥匙行按注释 agent-hub:<设备名> 认是哪台的
lines_of() { grep -E " agent-hub:$1\$" "$KEYS_FILE" 2>/dev/null || true; }
lines_except() { grep -vE " agent-hub:$1\$" "$KEYS_FILE" 2>/dev/null || true; }

write_keys() {
  local content="$1" tmp
  tmp=$(mktemp "$KEYS_FILE.XXXXXX")
  [ -n "$content" ] && printf '%s\n' "$content" >"$tmp"
  chown root:root "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$KEYS_FILE"
}

# 结束隧道用户在这些端口上的会话（sshd 替 -R 听端口的是这台设备那条会话的进程，ss -tlnp 能看到它的进程号）。
# 没给端口：结束所有在听“已经没有钥匙行允许的端口”的会话。
# ss 看不到进程号时（root 没有 CAP_SYS_PTRACE，比如容器里）退回结束隧道用户的全部会话：别的设备按退避 1 秒后自己连回来。
kill_sessions() {
  local allowed pid port owner line killed=0 blind=0
  allowed=$(grep -o 'permitlisten="[0-9]*"' "$KEYS_FILE" 2>/dev/null | grep -o '[0-9]*' || true)
  while read -r line; do
    [ -n "$line" ] || continue
    port=$(awk '{print $4}' <<<"$line" | sed 's/.*://')
    if [ $# -gt 0 ]; then
      [[ " $* " == *" $port "* ]] || continue
    else
      # 只看槽位那一段端口：别的端口不是隧道会话听的
      [ "$port" -ge "$SLOT_PORT_MIN" ] && [ "$port" -le "$SLOT_PORT_MAX" ] || continue
      grep -qxF "$port" <<<"$allowed" && continue
    fi
    if ! grep -q 'pid=' <<<"$line"; then blind=1; continue; fi
    grep -q '"sshd' <<<"$line" || continue
    for pid in $(grep -o 'pid=[0-9]*' <<<"$line" | cut -d= -f2 | sort -u); do
      owner=$(stat -c %U "/proc/$pid" 2>/dev/null || true)
      [ "$owner" = "$TUNNEL_USER" ] || continue
      kill "$pid" 2>/dev/null && killed=$((killed + 1)) && log "结束了端口 $port 上的隧道会话（进程 $pid）"
    done
  done < <(ss -Htlnp 2>/dev/null || true)
  if [ "$blind" -eq 1 ]; then
    for pid in /proc/[0-9]*; do
      [ "$(stat -c %U "$pid" 2>/dev/null)" = "$TUNNEL_USER" ] || continue
      kill "${pid#/proc/}" 2>/dev/null && killed=$((killed + 1))
    done
    log "看不到端口属于哪个进程，结束了 $TUNNEL_USER 的全部会话（$killed 个进程），别的设备会自己重连"
  fi
  [ "$killed" -gt 0 ] || skip "没有要结束的隧道会话"
}

ensure_key_line() {
  local name="$1" port="$2" entry_port="$3" pubkey="$4" body line current others
  body=$(awk '{print $2}' <<<"$pubkey")
  line="restrict,port-forwarding,permitlisten=\"$port\",permitopen=\"127.0.0.1:$entry_port\",command=\"$NOLOGIN\" ssh-ed25519 $body agent-hub:$name"
  current=$(lines_of "$name")
  others=$(lines_except "$name")
  # sshd 用第一条对得上的钥匙行：同一把钥匙挂在两台设备名下会拿错端口；同一个端口给两台会互相抢
  if grep -qF " ssh-ed25519 $body " <<<"$others"; then die "这把公钥已经是别的设备的了"; fi
  if grep -qF "permitlisten=\"$port\"" <<<"$others"; then die "端口 $port 已经给了别的设备"; fi
  if [ "$current" = "$line" ]; then skip "$name 的钥匙行已是最新"; return; fi
  write_keys "$(printf '%s\n%s' "$others" "$line" | sed '/^$/d')"
  if [ -z "$current" ]; then
    log "加了 $name 的钥匙行（-R $port、-L 127.0.0.1:$entry_port）"
  else
    log "换了 $name 的钥匙行（-R $port、-L 127.0.0.1:$entry_port）"
    # 换钥匙：旧钥匙建的会话还占着端口，断掉它新钥匙才连得上
    kill_sessions "$port"
  fi
}

remove_key_line() {
  local name="$1" current
  current=$(lines_of "$name")
  if [ -z "$current" ]; then
    skip "没有 $name 的钥匙行"
  else
    write_keys "$(lines_except "$name")"
    log "删了 $name 的钥匙行"
  fi
  # 只按现状收：所有不再有钥匙行的端口上的会话（删行后中断，再跑一次也能补上）
  kill_sessions
}

# ───────────── 入口 ─────────────
[ $# -ge 1 ] || usage
command="$1"
shift
NAME="" PORT="" ENTRY_PORT="" PUBKEY="" ADMIN_USER="${SUDO_USER:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2-}"; shift 2 ;;
    --port) PORT="${2-}"; shift 2 ;;
    --entry-port) ENTRY_PORT="${2-}"; shift 2 ;;
    --pubkey) PUBKEY="${2-}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2-}"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$ADMIN_USER" ] && [ "$ADMIN_USER" != root ] || ADMIN_USER=ubuntu
[ "$(id -u)" -eq 0 ] || die "要用 root 跑（sudo）"
valid_name "$NAME" || die "设备名只能用小写字母、数字和 -，1–32 个，不以 - 开头"
[[ "$ADMIN_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "管理员用户名不对：$ADMIN_USER"

case "$command" in
  add-key)
    valid_port "$PORT" || die "槽位端口不对：$PORT"
    valid_port "$ENTRY_PORT" || die "设备入口端口不对：$ENTRY_PORT"
    [[ "$PUBKEY" =~ ^ssh-ed25519\ AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+={0,2}(\ [^[:cntrl:]]*)?$ ]] || die "公钥要是一行 ssh-ed25519"
    ensure_user
    ensure_keys_dir
    ensure_snippet "$ENTRY_PORT"
    ensure_key_line "$NAME" "$PORT" "$ENTRY_PORT" "$PUBKEY"
    ;;
  remove-key)
    ensure_keys_dir
    remove_key_line "$NAME"
    ;;
  *) usage ;;
esac
