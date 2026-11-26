#!/usr/bin/env bash
# Forced command for the remote test user's SSH key (authorized_keys command="/home/bellwood-test/bin/tester-remote").
# Accepts only status [presence|router-chats], start <real|fake>, stop, restart <real|fake>, deploy <40-hex commit>, and logs <1..2000>.
set -euo pipefail

APP_DIR="${BELLWOOD_TESTER_APP_DIR:-$HOME/agent-hub}"
SERVICE="${BELLWOOD_TESTER_SERVICE:-bellwood-tester}"
PORT="${BELLWOOD_TESTER_PORT:-4417}"
DATA_DIR="${BELLWOOD_TESTER_DATA_DIR:-${AGENT_HUB_HOME:-$HOME/.agent-hub}}"
HEALTH_TIMEOUT_S="${BELLWOOD_TESTER_HEALTH_TIMEOUT_S:-60}"
REPO_URL="${BELLWOOD_TESTER_REPO_URL:-https://github.com/maodesikeng-boop/agent-hub}"
SYSTEMD_DIR="$HOME/.config/systemd/user"
MODE_ENV="$SYSTEMD_DIR/${SERVICE}.mode.env"
STATE_DIR="$HOME/.config/${SERVICE}"
MODE_FILE="$STATE_DIR/mode"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.kimi-code/bin:$HOME/.pi/bin:$HOME/.npm-global/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}:/usr/local/bin"

die() { printf 'tester-remote: %s\n' "$*" >&2; exit 2; }

parse_args() {
  if [ "${SSH_ORIGINAL_COMMAND+set}" = set ]; then
    [ -n "$SSH_ORIGINAL_COMMAND" ] || die "missing command"
    [[ "$SSH_ORIGINAL_COMMAND" =~ ^[A-Za-z0-9_.\ -]+$ ]] || die "disallowed characters in command"
    read -r -a ARGS <<< "$SSH_ORIGINAL_COMMAND"
  else
    [ $# -gt 0 ] || die "missing command"
    ARGS=("$@")
  fi
}

read_mode() {
  if [ -f "$MODE_FILE" ]; then
    local m
    m=$(tr -d '[:space:]' < "$MODE_FILE")
    if [ "$m" = "fake" ] || [ "$m" = "real" ]; then printf '%s' "$m"; return; fi
  fi
  printf 'real'
}

write_mode_env() {
  local mode="$1"
  mkdir -p "$SYSTEMD_DIR" "$STATE_DIR"
  if [ "$mode" = "real" ]; then
    : > "$MODE_ENV"
  else
    local fake_dir="$STATE_DIR/fake"
    mkdir -p "$fake_dir"
    node "$APP_DIR/test/tester/cli.ts" fake-script > "$fake_dir/script.json"
    cat > "$fake_dir/fake-claude" <<EOF
#!/usr/bin/env sh
exec node "$APP_DIR/test/fake-claude/fake-claude.ts" "\$@"
EOF
    chmod 0755 "$fake_dir/fake-claude"
    cat > "$MODE_ENV" <<EOF
AGENT_HUB_CLAUDE_PATH=$fake_dir/fake-claude
FAKE_CLAUDE_SCRIPT=$fake_dir/script.json
FAKE_CLAUDE_LOG=$fake_dir/fake-claude.log
FAKE_CLAUDE_STATE=$fake_dir
EOF
  fi
  chmod 0600 "$MODE_ENV"
  printf '%s\n' "$mode" > "$MODE_FILE"
}

wait_healthy() {
  local token_file="$DATA_DIR/state/ui-token"
  local cookie_file token auth_code code i
  cookie_file=$(mktemp)
  trap 'rm -f "$cookie_file"' RETURN
  for ((i = 0; i < HEALTH_TIMEOUT_S; i++)); do
    if [ -s "$token_file" ]; then
      token=$(tr -d '[:space:]' < "$token_file")
      if [ -n "$token" ]; then
        auth_code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 -c "$cookie_file" "http://127.0.0.1:${PORT}/auth?token=${token}" || true)
        if [ "$auth_code" = "302" ] || [ "$auth_code" = "200" ]; then
          code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 -b "$cookie_file" "http://127.0.0.1:${PORT}/api/health" || true)
          if [ "$code" = "200" ]; then
            rm -f "$cookie_file"
            trap - RETURN
            return 0
          fi
        fi
      fi
    fi
    [ "$i" -lt $((HEALTH_TIMEOUT_S - 1)) ] && sleep 1
  done
  rm -f "$cookie_file"
  trap - RETURN
  journalctl --user -u "$SERVICE" -n 30 --no-pager >&2 || true
  printf 'tester-remote: %s did not answer /api/health within %s s\n' "$SERVICE" "$HEALTH_TIMEOUT_S" >&2
  return 1
}

cmd_status() {
  local active commit
  active=$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)
  [ -n "$active" ] || active="unknown"
  if [ -f "$APP_DIR/.deployed-sha" ]; then
    commit=$(tr -d '[:space:]' < "$APP_DIR/.deployed-sha")
  elif [ -d "$APP_DIR/.git" ]; then
    commit=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
  else
    commit="unknown"
  fi
  printf 'service %s\n' "$active"
  printf 'commit %s\n' "$commit"
  printf 'mode %s\n' "$(read_mode)"
  local lines id cmd install login ver
  lines=$(node "$APP_DIR/scripts/print-vendors.ts")
  while IFS=$'\t' read -r id cmd install login; do
    if command -v "$cmd" >/dev/null 2>&1; then
      ver=$("$cmd" --version 2>&1 </dev/null | head -n1 || true)
      printf 'cli %s installed %s\n' "$id" "$ver"
    else
      printf 'cli %s missing\n' "$id"
    fi
  done <<< "$lines"
}

cmd_status_detail() {
  node --input-type=module - "$DATA_DIR/state/ui-token" "$PORT" "$1" <<'JS'
import { readFileSync } from "node:fs";
const [file, port, detail] = process.argv.slice(2);
const path = detail === "presence" ? "/api/account" : "/api/feishu";
const origin = "http://127.0.0.1:" + port;
const signal = AbortSignal.timeout(5000);
const token = readFileSync(file, "utf8").trim();
const login = await fetch(origin + "/auth?token=" + encodeURIComponent(token), { redirect: "manual", signal });
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
if (login.status !== 302 || !cookie) throw new Error("test daemon login failed");
const res = await fetch(origin + path, { headers: { cookie }, signal });
if (!res.ok) throw new Error("test daemon request failed: HTTP " + res.status);
const view = await res.json();
if (detail === "presence") {
  if (view.state !== "signed_in") throw new Error("test daemon is not signed in to Mesh");
  for (const device of view.devices) {
    if (!device.self && /^[0-9a-f-]{36}$/.test(device.id)) console.log("presence", device.id, device.online ? "online" : "offline");
  }
} else if (/^cli_[a-z0-9]+$/i.test(view.appId)) {
  for (const chat of view.chats) {
    if (chat.target?.kind === "router" && /^oc_[a-z0-9]+$/i.test(chat.chatId)) console.log("router-chat", view.appId, chat.chatId);
  }
}
JS
}

cmd_deploy() {
  local commit="$1" deployed=""
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "deploy requires a 40-char lowercase hex commit"
  if [ -f "$APP_DIR/.deployed-sha" ]; then
    deployed=$(tr -d '[:space:]' < "$APP_DIR/.deployed-sha")
  fi
  if [ "$deployed" != "$commit" ] || [ ! -d "$APP_DIR/dist/web" ] || [ ! -d "$APP_DIR/node_modules" ]; then
    local tmp src
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' RETURN
    curl -fsSL "${REPO_URL}/archive/${commit}.tar.gz" -o "$tmp/src.tar.gz"
    mkdir -p "$tmp/src"
    tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components=1
    mkdir -p "$APP_DIR"
    rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude .deployed-sha "$tmp/src/" "$APP_DIR/"
    (cd "$APP_DIR" && pnpm install --frozen-lockfile --reporter=append-only && pnpm build)
    printf '%s\n' "$commit" > "$APP_DIR/.deployed-sha"
    rm -rf "$tmp"
    trap - RETURN
  fi
  write_mode_env "$(read_mode)"
  systemctl --user restart "$SERVICE"
  wait_healthy
}

parse_args "$@"
case "${ARGS[0]}" in
  status)
    if [ ${#ARGS[@]} -eq 1 ]; then
      cmd_status
    elif [ ${#ARGS[@]} -eq 2 ] && { [ "${ARGS[1]}" = "presence" ] || [ "${ARGS[1]}" = "router-chats" ]; }; then
      cmd_status_detail "${ARGS[1]}"
    else
      die "status accepts only presence or router-chats as an optional argument"
    fi
    ;;
  stop)
    [ ${#ARGS[@]} -eq 1 ] || die "stop takes no arguments"
    systemctl --user stop "$SERVICE"
    ;;
  start|restart)
    [ ${#ARGS[@]} -eq 2 ] || die "${ARGS[0]} requires real|fake"
    [ "${ARGS[1]}" = "real" ] || [ "${ARGS[1]}" = "fake" ] || die "unknown mode: ${ARGS[1]}"
    write_mode_env "${ARGS[1]}"
    systemctl --user "${ARGS[0]}" "$SERVICE"
    wait_healthy
    ;;
  deploy)
    [ ${#ARGS[@]} -eq 2 ] || die "deploy requires a commit"
    cmd_deploy "${ARGS[1]}"
    ;;
  logs)
    [ ${#ARGS[@]} -eq 2 ] || die "logs requires a line count"
    [[ "${ARGS[1]}" =~ ^[1-9][0-9]*$ ]] || die "logs line count must be 1..2000"
    [ "${ARGS[1]}" -le 2000 ] || die "logs line count must be 1..2000"
    journalctl --user -u "$SERVICE" -n "${ARGS[1]}" --no-pager
    ;;
  *)
    die "unknown command: ${ARGS[0]}"
    ;;
esac
