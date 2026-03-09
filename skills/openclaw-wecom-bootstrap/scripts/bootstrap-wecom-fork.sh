#!/usr/bin/env bash
set -euo pipefail

REPO_URL_DEFAULT="https://github.com/zjoull123-star/openclaw-wecom-plugin-fork.git"
REPO_DIR_DEFAULT="${HOME}/.codex/vendor/openclaw-wecom-plugin-fork"
PLUGIN_ID="wecom-openclaw-plugin"
OWNER=""
BOT_ID=""
SECRET=""
REPO_URL="$REPO_URL_DEFAULT"
REPO_DIR="$REPO_DIR_DEFAULT"
PLUGIN_PATH=""
INSTALL_MODE="link"
SKIP_VALIDATE=0
SKIP_RESTART=0
ENABLE_OWNER_SHELL=0

usage() {
  cat <<USAGE
Usage:
  bootstrap-wecom-fork.sh --bot-id <id> --secret <secret> [options]

Options:
  --bot-id <id>           WeCom bot id.
  --secret <secret>       WeCom bot secret.
  --owner <userid>        WeCom owner userid for owner-only admin commands.
  --enable-owner-shell    Enable /bash and ! for the owner. Also sets agents.defaults.elevatedDefault to "off".
  --repo-url <url>        Git URL for the fork. Default: ${REPO_URL_DEFAULT}
  --repo-dir <dir>        Checkout directory when cloning/updating the fork.
  --plugin-path <dir>     Use an existing local repo checkout instead of cloning/updating repo-dir.
  --copy-install          Copy install instead of linked install.
  --skip-validate         Skip openclaw config validate.
  --skip-restart          Skip openclaw gateway restart.
  -h, --help              Show this help text.
USAGE
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

json_string() {
  python3 - "$1" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1]))
PY
}

merge_string_array() {
  local path="$1"
  local value="$2"
  local current
  if ! current="$(openclaw config get --json "$path" 2>/dev/null)"; then
    current='[]'
  fi
  python3 - "$current" "$value" <<'PY'
import json
import sys
raw = sys.argv[1]
value = sys.argv[2]
try:
    parsed = json.loads(raw)
except Exception:
    parsed = []
if not isinstance(parsed, list):
    parsed = []
seen = set()
merged = []
for item in parsed + [value]:
    item = str(item)
    if item in seen:
        continue
    seen.add(item)
    merged.append(item)
print(json.dumps(merged))
PY
}

config_set_json() {
  local path="$1"
  local value="$2"
  openclaw config set --strict-json "$path" "$value"
}

ensure_repo_checkout() {
  if [[ -n "$PLUGIN_PATH" ]]; then
    [[ -d "$PLUGIN_PATH" ]] || die "--plugin-path does not exist: $PLUGIN_PATH"
    REPO_DIR="$PLUGIN_PATH"
    return
  fi

  mkdir -p "$(dirname "$REPO_DIR")"
  if [[ -d "$REPO_DIR/.git" ]]; then
    git -C "$REPO_DIR" pull --ff-only
    return
  fi
  if [[ -e "$REPO_DIR" ]]; then
    die "Repo directory exists but is not a git checkout: $REPO_DIR"
  fi
  git clone "$REPO_URL" "$REPO_DIR"
}

install_plugin() {
  if [[ "$INSTALL_MODE" == "link" ]]; then
    openclaw plugins install --link "$REPO_DIR"
  else
    openclaw plugins install "$REPO_DIR"
  fi
  openclaw plugins enable "$PLUGIN_ID"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-id)
      [[ $# -ge 2 ]] || die "Missing value for --bot-id"
      BOT_ID="$2"
      shift 2
      ;;
    --secret)
      [[ $# -ge 2 ]] || die "Missing value for --secret"
      SECRET="$2"
      shift 2
      ;;
    --owner)
      [[ $# -ge 2 ]] || die "Missing value for --owner"
      OWNER="$2"
      shift 2
      ;;
    --enable-owner-shell)
      ENABLE_OWNER_SHELL=1
      shift
      ;;
    --repo-url)
      [[ $# -ge 2 ]] || die "Missing value for --repo-url"
      REPO_URL="$2"
      shift 2
      ;;
    --repo-dir)
      [[ $# -ge 2 ]] || die "Missing value for --repo-dir"
      REPO_DIR="$2"
      shift 2
      ;;
    --plugin-path)
      [[ $# -ge 2 ]] || die "Missing value for --plugin-path"
      PLUGIN_PATH="$2"
      shift 2
      ;;
    --copy-install)
      INSTALL_MODE="copy"
      shift
      ;;
    --skip-validate)
      SKIP_VALIDATE=1
      shift
      ;;
    --skip-restart)
      SKIP_RESTART=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$BOT_ID" ]] || die "--bot-id is required"
[[ -n "$SECRET" ]] || die "--secret is required"
if [[ "$ENABLE_OWNER_SHELL" -eq 1 && -z "$OWNER" ]]; then
  die "--enable-owner-shell requires --owner"
fi

need_cmd git
need_cmd openclaw
need_cmd python3

ensure_repo_checkout
install_plugin

plugins_allow_json="$(merge_string_array plugins.allow "$PLUGIN_ID")"
owner_allow_json='[]'
wecom_elevated_allow_json='[]'
if [[ -n "$OWNER" ]]; then
  owner_allow_json="$(merge_string_array commands.ownerAllowFrom "wecom:${OWNER}")"
  wecom_elevated_allow_json="$(merge_string_array tools.elevated.allowFrom.wecom "$OWNER")"
fi

config_set_json plugins.allow "$plugins_allow_json"
config_set_json channels.wecom.botId "$(json_string "$BOT_ID")"
config_set_json channels.wecom.secret "$(json_string "$SECRET")"
config_set_json channels.wecom.enabled true
config_set_json channels.wecom.dmPolicy '"open"'
config_set_json channels.wecom.allowFrom '["*"]'
config_set_json channels.wecom.groupPolicy '"open"'
config_set_json channels.wecom.configWrites true
config_set_json channels.wecom.autoProvision.enabled true
config_set_json channels.wecom.autoProvision.registryPath "$(json_string "${HOME}/.openclaw/credentials/wecom-auto-agents.json")"
config_set_json channels.wecom.autoProvision.templateDir "$(json_string "${HOME}/.openclaw/templates/wecom-default-agent")"
config_set_json channels.wecom.autoProvision.dm.agentIdPrefix '"wecom-dm"'
config_set_json channels.wecom.autoProvision.dm.workspaceRoot "$(json_string "${HOME}/.openclaw/workspace-wecom/dm")"
config_set_json channels.wecom.autoProvision.group.agentIdPrefix '"wecom-group"'
config_set_json channels.wecom.autoProvision.group.workspaceRoot "$(json_string "${HOME}/.openclaw/workspace-wecom/group")"
config_set_json channels.wecom.autoProvision.group.requireMention true

if [[ -n "$OWNER" ]]; then
  config_set_json commands.ownerAllowFrom "$owner_allow_json"
  config_set_json commands.config true
  config_set_json commands.restart true
  config_set_json tools.elevated.allowFrom.wecom "$wecom_elevated_allow_json"
fi

if [[ "$ENABLE_OWNER_SHELL" -eq 1 ]]; then
  config_set_json commands.bash true
  config_set_json tools.elevated.enabled true
  config_set_json agents.defaults.elevatedDefault '"off"'
fi

if [[ "$SKIP_VALIDATE" -eq 0 ]]; then
  openclaw config validate
fi

if [[ "$SKIP_RESTART" -eq 0 ]]; then
  openclaw gateway restart
fi

cat <<SUMMARY
Bootstrap complete.
Repo checkout: ${REPO_DIR}
Install mode: ${INSTALL_MODE}
WeCom enabled: yes
Owner configured: $( [[ -n "$OWNER" ]] && printf 'yes (%s)' "$OWNER" || printf 'no' )
Owner shell enabled: $( [[ "$ENABLE_OWNER_SHELL" -eq 1 ]] && printf 'yes' || printf 'no' )
SUMMARY
