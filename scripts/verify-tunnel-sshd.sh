#!/usr/bin/env bash
# 隧道 sshd 配置的容器验收（docs/hub-tunnel-design.md 第 3 节第 4 条，实现块 C、D）。改了 scripts/tunnel-sshd.sh 或 ssh 参数就重跑：
#   scripts/verify-tunnel-sshd.sh
# 要本机有 docker 和 node（≥ package.json 的 engines）。起一个一次性的 Ubuntu 24.04 容器（--rm，跑完就删），装 openssh-server，
# 用 tunnel-sshd.sh add-key 生成的配置真连一遍 sshd：
#   - 连入方的 ssh 参数用守护进程那份拼装（src/daemon/tunnel/ssh-args.ts 的 buildSshArgs），换成容器里的路径；
#   - 能 -R 自己的槽位 4401、能 -L 到设备入口 4319；看到 ssh 报 “remote forward success” 才算连上（监督靠这一行判断连上）；
#   - -R 4402（别的设备的槽位）、-L 到 4318（浏览器端口）、-L 到 22、-L 到 unix socket、要 shell、要 PTY 全部失败；
#   - 旧的 run/tunnel/hub.sock 留着也能重连上（StreamLocalBindUnlink）；
#   - 改片段前后 sshd -T 看管理员用户 ubuntu 的配置不变；同一条 add-key 连跑两遍配置不变（文件 inode、修改时间都不动）；
#   - 中途失败能补齐（标记了待 reload、片段被删、钥匙行被改，再跑一次都改回）；片段没作用到隧道用户时撤回、报错；
#   - remove-key 删钥匙行、断这台的现存会话，再跑一遍不变。
# 脚本自己也是容器里跑的那一半（加 --in-container）。

set -euo pipefail

IMAGE=ubuntu:24.04
# 容器里的路径（和真机一样的布局：代码在 /opt/agent-hub，连入方的数据目录在 /root/mac）
IN_SCRIPTS=/opt/agent-hub/scripts
MAC=/root/mac

pass() { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
step() { printf '\033[1;34m[verify]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ═══════════════════════ 本机这一半 ═══════════════════════
on_host() {
  local root work
  root=$(cd "$(dirname "$0")/.." && pwd)
  command -v docker >/dev/null || fail "没有 docker"
  docker info >/dev/null 2>&1 || fail "docker 没在跑（Docker Desktop 打开了吗？）"
  work=$(mktemp -d)
  trap "rm -rf '$work'" EXIT
  # 守护进程那份参数拼装，路径换成容器里的
  node --input-type=module -e "
    import { buildSshArgs } from '$root/src/daemon/tunnel/ssh-args.ts';
    const args = buildSshArgs({
      host: '127.0.0.1', sshPort: 22, user: 'agenthub-tunnel', listenPort: 4401, hubEntryPort: 4319,
      keyFile: '$MAC/state/tunnel/id_ed25519', knownHostsFile: '$MAC/state/tunnel/known_hosts',
      peerSocket: '$MAC/run/peer.sock', hubSocket: '$MAC/run/tunnel/hub.sock',
    });
    process.stdout.write(args.join('\n') + '\n');
  " >"$work/ssh-args.txt"
  step "连入方 ssh 参数（ssh-args.ts）：$(tr '\n' ' ' <"$work/ssh-args.txt")"
  # SYS_PTRACE：真机上 root 有，ss -p 才看得到隧道用户的会话进程（docker 默认去掉了）
  docker run --rm -i --cap-add SYS_PTRACE -v "$root/scripts:$IN_SCRIPTS:ro" -v "$work:/work:ro" "$IMAGE" bash "$IN_SCRIPTS/verify-tunnel-sshd.sh" --in-container
}

# ═══════════════════════ 容器这一半 ═══════════════════════
TUNNEL=$IN_SCRIPTS/tunnel-sshd.sh
SNIPPET=/etc/ssh/sshd_config.d/agent-hub-tunnel.conf
KEYS=/etc/ssh/agent-hub-tunnel/authorized_keys
PENDING=/etc/ssh/agent-hub-tunnel/.reload-pending

admin_config() { /usr/sbin/sshd -T -C user=ubuntu,host=x,addr=203.0.113.1; }
state_of() { stat -c '%n %i %Y %a %U' "$SNIPPET" "$KEYS"; sha256sum "$SNIPPET" "$KEYS"; getent passwd agenthub-tunnel; getent shadow agenthub-tunnel | cut -d: -f1,2; }
add_mac() { "$TUNNEL" add-key --name mac --port 4401 --entry-port 4319 --pubkey "$(cat "$MAC/state/tunnel/id_ed25519.pub")" --admin-user ubuntu; }

# 起一个 ssh 在后台，等它的 stderr 出现某一行（最多 10 秒）
wait_line() {
  local file="$1" pattern="$2" i
  for i in $(seq 1 100); do
    grep -q "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}
# 用守护进程那份参数连上（中心上旧会话还没放掉 4401 时会失败：像监督一样过一会儿再连），连上的进程号放进 TUNNEL_PID
connect_tunnel() {
  local log="$1" i
  for i in 1 2 3 4 5; do
    ssh "${ARGS[@]}" 2>"$log" &
    TUNNEL_PID=$!
    wait_line "$log" "remote forward success for: listen 4401" && return 0
    kill "$TUNNEL_PID" 2>/dev/null || true
    sleep 1
  done
  return 1
}
# 连到一个地址，读它说的第一句（3 秒没有就算空）
read_from() { timeout 5 socat -T3 - "$1" </dev/null 2>/dev/null || true; }

# 用 mac 的钥匙、但不是守护进程那份参数（负面测试，最多 10 秒）：只读本方案生成的文件
neg_ssh() {
  timeout 10 ssh -F /dev/null -i "$MAC/state/tunnel/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$MAC/state/tunnel/known_hosts" -o HostKeyAlias=agent-hub-hub -o HostKeyAlgorithms=ssh-ed25519 \
    -o ConnectTimeout=5 "$@"
}

in_container() {
  export DEBIAN_FRONTEND=noninteractive
  step "装 openssh-server（Ubuntu 24.04）"
  apt-get update -qq >/dev/null
  apt-get install -y -qq openssh-server openssh-client iproute2 socat >/dev/null
  ssh -V
  ssh-keygen -A >/dev/null
  install -d -m 0755 /run/sshd
  /usr/sbin/sshd
  local baseline
  baseline=$(admin_config)

  # 连入方：专用钥匙、钉死容器的主机公钥（和守护进程写的一样：known_hosts 一行“别名 公钥”）
  install -d -m 0700 "$MAC/state/tunnel" "$MAC/run/tunnel"
  ssh-keygen -q -t ed25519 -N '' -C agent-hub -f "$MAC/state/tunnel/id_ed25519"
  ssh-keygen -q -t ed25519 -N '' -C agent-hub -f /root/linux_key
  printf 'agent-hub-hub %s\n' "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" >"$MAC/state/tunnel/known_hosts"
  mapfile -t ARGS </work/ssh-args.txt

  step "add-key：建用户、写片段、写钥匙行"
  add_mac
  [ "$(admin_config)" = "$baseline" ] && pass "sshd -T：管理员用户 ubuntu 的配置和改之前一样" || fail "ubuntu 的 sshd 配置变了"
  [ ! -e "$PENDING" ] && pass "已 reload（没有待 reload 标记）" || fail "还有待 reload 标记"
  grep -q '^agenthub-tunnel:.*:/nonexistent:/usr/sbin/nologin$' /etc/passwd && pass "用户 agenthub-tunnel：nologin、没有家目录" || fail "用户不对"
  [ "$(stat -c '%U %a' "$KEYS")" = "root 644" ] && pass "钥匙行文件 root 所有、0644" || fail "钥匙行文件权限不对"

  step "同一条 add-key 再跑一遍：配置不变"
  local before
  before=$(state_of)
  add_mac 2>"/tmp/second.log"
  [ "$(state_of)" = "$before" ] && pass "片段、钥匙行、用户都没动（inode、修改时间一样）" || fail "第二遍改了东西：$(diff <(echo "$before") <(state_of))"
  ! grep -qv '不动' /tmp/second.log && pass "第二遍每一步都是“不动”" || fail "第二遍有改动：$(cat /tmp/second.log)"
  [ "$(admin_config)" = "$baseline" ] && pass "sshd -T 比对仍通过" || fail "ubuntu 的 sshd 配置变了"

  step "再加一台 linux（槽位 4402）"
  "$TUNNEL" add-key --name linux --port 4402 --entry-port 4319 --pubkey "$(cat /root/linux_key.pub)" 2>/dev/null
  [ "$(grep -c agent-hub: "$KEYS")" = 2 ] && pass "两行钥匙" || fail "钥匙行数不对"
  if "$TUNNEL" add-key --name pi --port 4401 --entry-port 4319 --pubkey "$(cat /root/linux_key.pub)" 2>/dev/null; then fail "同一把钥匙 / 端口给了两台"; fi
  pass "同一把钥匙、同一个端口不能给第二台"
  # 4401 这时没人占：失败只能是因为钥匙行不许
  if timeout 10 ssh -F /dev/null -i /root/linux_key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -N -o ExitOnForwardFailure=yes -R 4401:127.0.0.1:9 agenthub-tunnel@127.0.0.1 2>/dev/null; then fail "linux 的钥匙抢到了 4401"; fi
  pass "linux 的钥匙抢不到 mac 的 4401"

  # 中心上的服务：设备入口 4319、浏览器端口 4318、一个 unix socket；连入方的设备入口 peer.sock
  socat TCP-LISTEN:4319,bind=127.0.0.1,fork,reuseaddr SYSTEM:'echo hello-4319' &
  socat TCP-LISTEN:4318,bind=127.0.0.1,fork,reuseaddr SYSTEM:'echo hello-4318' &
  socat UNIX-LISTEN:/tmp/forbidden.sock,fork SYSTEM:'echo hello-unix' &
  socat UNIX-LISTEN:"$MAC/run/peer.sock",fork SYSTEM:'echo hello-peer' &
  sleep 0.5

  step "守护进程那份参数连上（能 -R 4401、能 -L 到 4319）"
  ssh "${ARGS[@]}" 2>/tmp/tunnel1.log &
  local tunnel1=$!
  wait_line /tmp/tunnel1.log "remote forward success for: listen 4401" && pass "ssh 报 remote forward success（监督据此判 connected）" || fail "没连上：$(grep -v '^debug' /tmp/tunnel1.log)"
  [ "$(read_from TCP:127.0.0.1:4401)" = hello-peer ] && pass "中心 127.0.0.1:4401 → 连入方 peer.sock" || fail "-R 4401 不通"
  [ "$(read_from UNIX-CONNECT:$MAC/run/tunnel/hub.sock)" = hello-4319 ] && pass "连入方 hub.sock → 中心 127.0.0.1:4319" || fail "-L → 4319 不通"
  [ "$(stat -c '%a' "$MAC/run/tunnel/hub.sock")" = 600 ] && pass "hub.sock 0600" || fail "hub.sock 权限 $(stat -c '%a' "$MAC/run/tunnel/hub.sock")"
  ! ss -Htln | awk '{print $4}' | grep -qE '^(0\.0\.0\.0|\*|\[::\]):4401$' && pass "4401 只听回环（GatewayPorts no）" || fail "4401 对外听了"

  step "旧的 hub.sock 留着也能重连上"
  kill "$tunnel1"
  wait "$tunnel1" 2>/dev/null || true
  [ -S "$MAC/run/tunnel/hub.sock" ] && pass "ssh 退出后 hub.sock 还在（这就是问题本身）" || fail "hub.sock 被删了，测不到"
  local without=() a
  for a in "${ARGS[@]}"; do if [ "$a" = StreamLocalBindUnlink=yes ]; then without+=(StreamLocalBindUnlink=no); else without+=("$a"); fi; done
  if timeout 10 ssh "${without[@]}" 2>/tmp/no-unlink.log; then fail "不带 StreamLocalBindUnlink 也连上了"; fi
  grep -v '^debug' /tmp/no-unlink.log | grep -qi 'forwarding\|bind' && pass "不带 StreamLocalBindUnlink：建 -L 失败退出（$(grep -v '^debug' /tmp/no-unlink.log | grep -i 'forwarding\|bind' | head -1)）" || fail "没按预期失败：$(grep -v '^debug' /tmp/no-unlink.log)"
  connect_tunnel /tmp/tunnel2.log && pass "带 StreamLocalBindUnlink：重连上了" || fail "重连不上：$(grep -v '^debug' /tmp/tunnel2.log)"
  [ "$(read_from UNIX-CONNECT:$MAC/run/tunnel/hub.sock)" = hello-4319 ] && pass "新的 hub.sock 通" || fail "新的 hub.sock 不通"

  step "这把钥匙不能做的事"
  if neg_ssh -N -o ExitOnForwardFailure=yes -R 4402:127.0.0.1:9 agenthub-tunnel@127.0.0.1 2>/tmp/r4402.log; then fail "-R 4402 成功了"; fi
  grep -q 'remote port forwarding failed for listen port 4402' /tmp/r4402.log && pass "-R 4402（别的设备的槽位）失败" || fail "-R 4402：$(cat /tmp/r4402.log)"
  neg_ssh -N -L 15019:127.0.0.1:4319 -L 15018:127.0.0.1:4318 -L 15022:127.0.0.1:22 -L 15050:/tmp/forbidden.sock agenthub-tunnel@127.0.0.1 2>/tmp/local.log &
  local neg=$!
  sleep 1.5
  [ "$(read_from TCP:127.0.0.1:15019)" = hello-4319 ] && pass "（对照）-L → 4319 通" || fail "-L → 4319 不通"
  [ -z "$(read_from TCP:127.0.0.1:15018)" ] && pass "-L → 4318（浏览器端口）不通" || fail "-L → 4318 通了"
  [ -z "$(read_from TCP:127.0.0.1:15022)" ] && pass "-L → 22 不通" || fail "-L → 22 通了"
  [ -z "$(read_from TCP:127.0.0.1:15050)" ] && pass "-L → unix socket 不通" || fail "-L → unix socket 通了"
  kill "$neg" 2>/dev/null || true
  grep -q 'administratively prohibited' /tmp/local.log && pass "sshd 回 administratively prohibited" || fail "$(cat /tmp/local.log)"
  local out
  out=$(neg_ssh -T agenthub-tunnel@127.0.0.1 'echo PWNED; id' 2>&1 || true)
  ! grep -q 'PWNED\|uid=' <<<"$out" && pass "要 shell / 跑命令：只跑 nologin（$(head -1 <<<"$out")）" || fail "跑了命令：$out"
  out=$(neg_ssh -tt agenthub-tunnel@127.0.0.1 2>&1 </dev/null || true)
  grep -q 'PTY allocation request failed' <<<"$out" && ! grep -q 'uid=' <<<"$out" && pass "要 PTY：被拒" || fail "PTY：$out"

  step "中途失败再跑一次能补齐"
  : >"$PENDING"
  add_mac 2>/tmp/pending.log
  [ ! -e "$PENDING" ] && grep -q '补上' /tmp/pending.log && pass "写了片段没 reload：补 reload" || fail "没补 reload：$(cat /tmp/pending.log)"
  rm -f "$SNIPPET"
  add_mac 2>/dev/null
  [ -f "$SNIPPET" ] && [ "$(admin_config)" = "$baseline" ] && pass "片段被删：写回，sshd -T 比对通过" || fail "片段没写回"
  sed -i 's/permitlisten="4401"/permitlisten="4499"/' "$KEYS"
  add_mac 2>/tmp/rekey.log
  grep -q 'permitlisten="4401".* agent-hub:mac$' "$KEYS" && ! grep -q 4499 "$KEYS" && pass "钥匙行被改：改回" || fail "钥匙行没改回"
  # 钥匙行换了：这台的现存会话（用的是旧行）被断开，只断它
  for i in $(seq 1 50); do kill -0 "$TUNNEL_PID" 2>/dev/null || break; sleep 0.1; done
  ! kill -0 "$TUNNEL_PID" 2>/dev/null && grep -q '结束了端口 4401' /tmp/rekey.log && pass "钥匙行换了：断开这台的现存会话（$(grep 结束 /tmp/rekey.log)）" || fail "换钥匙行没断会话：$(cat /tmp/rekey.log)"

  step "片段没作用到隧道用户（主配置不 Include）：撤回、报错"
  cp /etc/ssh/sshd_config /root/sshd_config.bak
  sed -i 's|^Include /etc/ssh/sshd_config.d/\*.conf|#&|' /etc/ssh/sshd_config
  rm -f "$SNIPPET"
  if add_mac 2>/tmp/noinclude.log; then fail "没 Include 也成功了"; fi
  [ ! -e "$SNIPPET" ] && [ ! -e "$PENDING" ] && pass "撤回了片段（$(grep 失败 /tmp/noinclude.log)）" || fail "片段没撤回"
  cp /root/sshd_config.bak /etc/ssh/sshd_config
  add_mac 2>/dev/null
  [ "$(admin_config)" = "$baseline" ] && pass "恢复后再跑：补齐，sshd -T 比对通过" || fail "恢复后不对"

  step "remove-key：删钥匙行、断现存会话；再跑一遍不变"
  connect_tunnel /tmp/tunnel3.log || fail "删之前连不上：$(grep -v '^debug' /tmp/tunnel3.log)"
  "$TUNNEL" remove-key --name mac 2>/tmp/remove.log
  ! grep -q 'agent-hub:mac$' "$KEYS" && pass "删了 mac 的钥匙行" || fail "钥匙行还在"
  for i in $(seq 1 50); do kill -0 "$TUNNEL_PID" 2>/dev/null || break; sleep 0.1; done
  ! kill -0 "$TUNNEL_PID" 2>/dev/null && grep -q '结束了端口 4401' /tmp/remove.log && pass "mac 的现存会话被断开（$(grep 结束 /tmp/remove.log | head -1)）" || fail "现存会话还在：$(cat /tmp/remove.log; ss -Htlnp)"
  before=$(state_of)
  "$TUNNEL" remove-key --name mac 2>/dev/null
  [ "$(state_of)" = "$before" ] && pass "再删一遍：不变" || fail "第二遍改了东西"
  grep -q 'agent-hub:linux$' "$KEYS" && pass "linux 的钥匙行还在" || fail "linux 的钥匙行被删了"
  if timeout 10 ssh "${ARGS[@]}" 2>/tmp/removed.log; then fail "删了还能连"; fi
  grep -q 'Permission denied' /tmp/removed.log && pass "mac 的钥匙再连：Permission denied（监督判 auth_failed）" || fail "$(grep -v '^debug' /tmp/removed.log)"
  [ "$(admin_config)" = "$baseline" ] && pass "最后 sshd -T 比对仍通过" || fail "ubuntu 的 sshd 配置变了"

  step "全部通过"
}

if [ "${1:-}" = --in-container ]; then in_container; else on_host; fi
