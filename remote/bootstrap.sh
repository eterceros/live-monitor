#!/usr/bin/env bash
# Prepares a dev box so the board can run tasks on it. Idempotent: run it as
# many times as you like, and run a single stage with `bootstrap.sh <stage>`.
#
#   network    Tailscale, joined to your tailnet, with Tailscale SSH
#   git        commit identity + a signed commit made without anyone at the keyboard
#   playwright the e2e suite's dependencies and Chromium
#   runner     this repo, its dependencies, and the runner as a user service
#   all        (default) every stage above, in that order
#
# What it needs: sudo, `claude` already logged in (`claude auth status`), `gh`
# already logged in, and the hfs repo cloned at $HFS_REPO.
set -euo pipefail

HFS_REPO="${HFS_REPO:-$HOME/src/hfs}"
HFS_WT="${HFS_WT:-$HOME/src/hfs-wt}"
MONITOR_DIR="${MONITOR_DIR:-$HOME/src/hfs-monitor}"
MONITOR_REPO="${MONITOR_REPO:-git@github.com:eterceros/hfs-monitor.git}"
RUNNER_PORT="${RUNNER_PORT:-7421}"
GIT_NAME="${GIT_NAME:-$(git config --global user.name 2>/dev/null || true)}"
GIT_EMAIL="${GIT_EMAIL:-$(git config --global user.email 2>/dev/null || true)}"
# Must match the SDK the board runs: SDK 0.3.N pairs with CLI 2.1.N.
CLAUDE_VERSION_WANTED="${CLAUDE_VERSION_WANTED:-2.1.314}"
# Must match config.json `qa.mcpVersion` on the board.
MCP_VERSION="${MCP_VERSION:-0.0.80}"

say()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '   \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

stage_network() {
  say "network: Tailscale"
  if ! command -v tailscale >/dev/null; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  ok "tailscale $(tailscale version | head -1)"
  # An LXC container without /dev/net/tun (runner-1 is one) cannot run the
  # kernel path. Userspace networking still accepts incoming connections and
  # hands them to services listening on loopback, which is all the runner needs.
  if [ ! -e /dev/net/tun ]; then
    if ! grep -q 'userspace-networking' /etc/default/tailscaled 2>/dev/null; then
      echo 'FLAGS="--tun=userspace-networking"' | sudo tee -a /etc/default/tailscaled >/dev/null
      sudo systemctl restart tailscaled
      sleep 2
    fi
    warn "sin /dev/net/tun: Tailscale en modo userspace (el runner escuchará en 127.0.0.1 y Tailscale le pasa lo que entra)"
  fi
  if tailscale status >/dev/null 2>&1 && tailscale ip -4 >/dev/null 2>&1; then
    ok "already in the tailnet as $(tailscale ip -4 | head -1)"
  else
    warn "joining the tailnet: open the URL below in your browser and approve this machine"
    sudo tailscale up --ssh --hostname "$(hostname)"
    ok "joined as $(tailscale ip -4 | head -1)"
  fi
  ok "Tailscale SSH on: from the laptop, 'ssh $(whoami)@$(hostname)' needs no key"
}

stage_git() {
  say "git: identity and unattended signing"
  [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ] || die "set GIT_NAME and GIT_EMAIL (there is no global git identity to keep)"
  git config --global user.name "$GIT_NAME"
  git config --global user.email "$GIT_EMAIL"
  ok "identity: $GIT_NAME <$GIT_EMAIL>"
  [ -d "$HFS_REPO/.git" ] || die "no repo at $HFS_REPO (set HFS_REPO)"
  mkdir -p "$HFS_WT"
  # The board commits through Claude with nobody watching: a key that asks
  # for a passphrase here would hang every fix. Prove it on a throwaway
  # worktree, then remove every trace.
  local probe="$HFS_WT/.signing-probe"
  rm -rf "$probe"
  git -C "$HFS_REPO" worktree prune
  git -C "$HFS_REPO" worktree add --detach "$probe" HEAD >/dev/null 2>&1
  if GIT_TERMINAL_PROMPT=0 timeout 30 git -C "$probe" commit --allow-empty -q -m "signing probe" </dev/null; then
    if git -C "$probe" log -1 --format='%G?' | grep -q '^[GU]$'; then
      ok "signed commit without a prompt"
    else
      warn "commit went through but is not signed (commit.gpgsign=$(git config --global --get commit.gpgsign))"
    fi
  else
    die "an unattended commit failed: the signing key asks for a passphrase, or gpg-agent is not caching it"
  fi
  git -C "$HFS_REPO" worktree remove --force "$probe"
  ok "worktree root: $HFS_WT"
}

stage_playwright() {
  say "playwright: dependencies and Chromium"
  local e2e="$HFS_REPO/crates/ui/e2e"
  [ -f "$e2e/package.json" ] || die "no e2e suite at $e2e"
  (cd "$e2e" && npm ci --no-audit --no-fund)
  (cd "$e2e" && sudo -E npx playwright install-deps chromium)
  (cd "$e2e" && npx playwright install chromium)
  ok "playwright $(cd "$e2e" && npx playwright --version)"

  # Browser QA drives a live browser through the Playwright MCP, which pins its
  # own Playwright and therefore its own Chromium build — a second one, next to
  # the suite's. Pre-warm the package and install that browser now, so the
  # first QA session does not spend its turn downloading.
  # QA videos are condensed (still stretches cut out) with a full ffmpeg.
  # Playwright's own build only records: no select/mpdecimate/setpts filters.
  if ! command -v ffmpeg >/dev/null; then
    say "playwright: a full ffmpeg, to cut the still stretches out of QA videos"
    sudo apt-get install -y ffmpeg >/dev/null
  fi
  ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"

  say "playwright: the MCP the QA phase drives the browser with"
  npx -y "@playwright/mcp@$MCP_VERSION" --version
  npx -y --package="@playwright/mcp@$MCP_VERSION" -c "playwright install --with-deps chromium" 2>&1 | tail -3 \
    || npx -y --package="@playwright/mcp@$MCP_VERSION" -c "playwright install chromium"
  ok "@playwright/mcp $MCP_VERSION and its Chromium: $(ls ~/.cache/ms-playwright | grep '^chromium-' | tr '\n' ' ')"
}

stage_runner() {
  say "runner: hfs-monitor as a user service"
  local claude_have
  claude_have="$(claude --version 2>/dev/null | awk '{print $1}')"
  [ "$claude_have" = "$CLAUDE_VERSION_WANTED" ] \
    || warn "claude is $claude_have, the board expects $CLAUDE_VERSION_WANTED — the board will refuse remote tasks until they match"
  claude auth status 2>/dev/null | grep -q '"loggedIn": true' || die "claude is not logged in here: run 'claude login'"
  gh auth status >/dev/null 2>&1 || die "gh is not logged in here: run 'gh auth login'"

  if [ -d "$MONITOR_DIR/.git" ]; then
    git -C "$MONITOR_DIR" pull --ff-only
  else
    git clone "$MONITOR_REPO" "$MONITOR_DIR"
  fi
  (cd "$MONITOR_DIR/server" && npm ci --omit=dev --no-audit --no-fund)

  local cfg="$HOME/.hfs-monitor/runner.json"
  mkdir -p "$HOME/.hfs-monitor"
  if [ ! -f "$cfg" ]; then
    local token
    token="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
    # Kernel Tailscale: bind the tailnet address and nothing else. Userspace
    # Tailscale: there is no such interface; bind loopback, which is where
    # tailscaled delivers incoming tailnet connections.
    local bind
    if [ -e /dev/net/tun ] && ! grep -q 'userspace-networking' /etc/default/tailscaled 2>/dev/null; then
      bind="$(tailscale ip -4 2>/dev/null | head -1 || echo 127.0.0.1)"
    else
      bind="127.0.0.1"
    fi
    cat > "$cfg" <<JSON
{
  "port": $RUNNER_PORT,
  "bind": "$bind",
  "token": "$token",
  "repoPath": "$HFS_REPO",
  "worktreeRoot": "$HFS_WT"
}
JSON
    chmod 600 "$cfg"
    ok "wrote $cfg (bind $bind)"
  fi

  mkdir -p "$HOME/.config/systemd/user"
  sed -e "s|@MONITOR_DIR@|$MONITOR_DIR|g" \
    "$MONITOR_DIR/remote/hfsmon-runner.service" > "$HOME/.config/systemd/user/hfsmon-runner.service"
  systemctl --user daemon-reload
  systemctl --user enable --now hfsmon-runner.service
  sleep 1
  systemctl --user --no-pager --lines=5 status hfsmon-runner.service || true
  loginctl show-user "$(whoami)" -p Linger | grep -q yes || warn "linger is off: 'sudo loginctl enable-linger $(whoami)' or the runner dies with your session"

  say "add this to the board's config.json on the laptop"
  cat <<JSON
"machines": {
  "local": { "kind": "local" },
  "$(hostname)": {
    "kind": "runner",
    "url": "http://$(tailscale ip -4 2>/dev/null | head -1):$RUNNER_PORT",
    "token": "$(python3 -c "import json;print(json.load(open('$cfg'))['token'])")",
    "repoPath": "$HFS_REPO",
    "worktreeRoot": "$HFS_WT"
  }
}
JSON
}

# Models are configured by family (`opus`, `sonnet`…) and the CLI resolves each
# to the newest version it knows — so staying on the newest models means
# keeping the CLI here and the SDK on the laptop at the same, current
# version. The board shows a chip when the SDK on npm is newer than its own.
#
# The laptop needs no `claude` of its own: the SDK ships the CLI it spawns,
# inside its platform package. So updating it there is one command.
#
# Laptop:  npm install @anthropic-ai/claude-agent-sdk@<version> --prefix server
#          then restart the board. Read the CLI version off the SDK's: 0.3.N ↔ 2.1.N.
# Here:    CLAUDE_VERSION_WANTED=2.1.N bootstrap.sh update
#
# An exact version, never `claude update`: that follows the `latest` channel,
# which can run ahead of the newest SDK and leave the two machines apart.
stage_update() {
  say "update: the claude CLI here, to $CLAUDE_VERSION_WANTED"
  local before
  before="$(claude --version 2>/dev/null | awk '{print $1}')"
  claude install "$CLAUDE_VERSION_WANTED" 2>&1 | tail -6 || die "install failed; check 'claude doctor'"
  local after
  after="$(claude --version 2>/dev/null | awk '{print $1}')"
  [ "$after" = "$CLAUDE_VERSION_WANTED" ] || warn "quedó en $after, no en $CLAUDE_VERSION_WANTED"
  ok "claude ${before} → ${after} (the laptop's SDK must pair with this: 0.3.N ↔ 2.1.N)"
  systemctl --user restart hfsmon-runner.service 2>/dev/null && ok "runner restarted" || true
}

stage="${1:-all}"
case "$stage" in
  network)    stage_network ;;
  git)        stage_git ;;
  playwright) stage_playwright ;;
  runner)     stage_runner ;;
  update)     stage_update ;;
  all)        stage_network; stage_git; stage_playwright; stage_runner ;;
  *) die "unknown stage '$stage' (network|git|playwright|runner|update|all)" ;;
esac
