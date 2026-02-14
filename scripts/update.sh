#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Astrobot v2 — Update Script
#
# Handles:
#   1. Git pull latest changes
#   2. Dependency updates
#   3. Agent container rebuild
#   4. Database migrations
#   5. Rolling restart of services
#   6. Optional: reconfigure models, name, or credentials
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── Colors ──────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()   { echo -e "${RED}[error]${NC} $*"; }
header(){ echo -e "\n${BOLD}${CYAN}── $* ──${NC}\n"; }
ask()   { echo -en "${BOLD}$*${NC} "; }

confirm() {
  local prompt="${1:-Continue?}"
  ask "$prompt [Y/n]"
  read -r answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

# ── Detect compose command ──────────────────────────────────────────

if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  err "Docker Compose not found."
  exit 1
fi

# All compose commands resolve op:// references at runtime via 'op run'
op_compose() {
  op run --env-file=.env --no-masking -- $COMPOSE "$@"
}

# Verify op can resolve secrets before doing anything with compose
verify_op_auth() {
  if ! op run --env-file=.env --no-masking -- printenv POSTGRES_PASSWORD &>/dev/null; then
    err "'op run' failed to resolve secrets from .env."
    info "Ensure 1Password is authenticated:"
    echo "  export OP_SERVICE_ACCOUNT_TOKEN=\"<your-token>\""
    echo "  # or: eval \$(op signin)"
    exit 1
  fi
}

# ── Pre-flight ──────────────────────────────────────────────────────

header "Astrobot Update"

if [[ ! -f .env ]]; then
  err ".env not found. Run ./scripts/deploy.sh for first-time setup."
  exit 1
fi

# Source current config for display (quote values to handle spaces in op:// refs)
source <(grep -v '^\s*#' .env | grep '=' | sed 's/^\([^=]*\)=\(.*\)/export \1="\2"/')

echo "Current configuration:"
echo "  Assistant:           ${ASSISTANT_NAME:-Nano}"
echo "  Orchestrator model:  ${ORCHESTRATOR_MODEL:-not set}"
echo "  Default agent model: ${DEFAULT_AGENT_MODEL:-not set}"
echo "  Embedding model:     ${EMBEDDING_MODEL:-not set}"
echo ""

# ── Parse flags ─────────────────────────────────────────────────────

SKIP_GIT=false
SKIP_DEPS=false
SKIP_BUILD=false
RECONFIGURE=false
SETUP_MCP=false
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-git)     SKIP_GIT=true ;;
    --no-deps)    SKIP_DEPS=true ;;
    --no-build)   SKIP_BUILD=true ;;
    --reconfigure) RECONFIGURE=true ;;
    --setup-mcp)  SETUP_MCP=true ;;
    --force|-f)   FORCE=true ;;
    --help|-h)
      echo "Usage: ./scripts/update.sh [options]"
      echo ""
      echo "Options:"
      echo "  --no-git        Skip git pull"
      echo "  --no-deps       Skip npm install"
      echo "  --no-build      Skip container rebuild"
      echo "  --reconfigure   Re-run model/name/credential configuration"
      echo "  --setup-mcp     Configure MCP server integrations (Slack, Todoist, etc.)"
      echo "  --force, -f     Skip confirmation prompts"
      echo "  --help, -h      Show this help"
      exit 0
      ;;
    *)
      warn "Unknown option: $1"
      ;;
  esac
  shift
done

# ── Git pull ────────────────────────────────────────────────────────

if [[ "$SKIP_GIT" == false ]]; then
  header "Pulling latest changes"

  # Check for uncommitted changes
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    warn "You have uncommitted changes."
    if [[ "$FORCE" == false ]]; then
      if ! confirm "Continue anyway? (changes will be stashed)"; then
        exit 0
      fi
      git stash
      info "Changes stashed. Run 'git stash pop' to restore."
    fi
  fi

  BEFORE=$(git rev-parse HEAD)
  git pull --rebase
  AFTER=$(git rev-parse HEAD)

  if [[ "$BEFORE" == "$AFTER" ]]; then
    ok "Already up to date"
  else
    COMMITS=$(git log --oneline "$BEFORE".."$AFTER" | wc -l | tr -d ' ')
    ok "Pulled $COMMITS new commit(s)"
    echo ""
    git log --oneline "$BEFORE".."$AFTER" | head -10
  fi
else
  info "Skipping git pull (--no-git)"
fi

# ── Reconfigure ─────────────────────────────────────────────────────

if [[ "$RECONFIGURE" == true ]]; then
  header "Reconfigure"

  # Read vault name from .env (set by deploy.sh)
  VAULT_NAME="$(grep '^OP_VAULT=' .env 2>/dev/null | cut -d= -f2- || echo "Astrobot")"
  VAULT_NAME="${VAULT_NAME:-Astrobot}"
  info "Using 1Password vault: $VAULT_NAME"

  # Check 1Password sign-in
  if ! op whoami &>/dev/null 2>&1; then
    warn "1Password CLI is not signed in. Run: eval \$(op signin)"
    warn "Skipping credential reconfiguration."
  else
    # -- Rotate credentials? --
    # Since .env contains op:// references, credential rotation only
    # updates the value in 1Password — .env stays unchanged.
    echo ""
    if confirm "Rotate Telegram bot token?"; then
      ask "New Telegram Bot Token:"
      read -rs NEW_TOKEN
      echo ""
      if [[ -n "$NEW_TOKEN" ]]; then
        op item edit "Telegram Bot" --vault "$VAULT_NAME" "token=$NEW_TOKEN" >/dev/null 2>&1 || \
          warn "Could not update 1Password item 'Telegram Bot'"
        ok "Telegram token updated in 1Password (op:// ref in .env resolves automatically)"
      fi
    fi

    if confirm "Rotate OpenRouter API key?"; then
      ask "New OpenRouter API Key:"
      read -rs NEW_KEY
      echo ""
      if [[ -n "$NEW_KEY" ]]; then
        op item edit "OpenRouter" --vault "$VAULT_NAME" "api key=$NEW_KEY" >/dev/null 2>&1 || \
          warn "Could not update 1Password item 'OpenRouter'"
        ok "OpenRouter key updated in 1Password (op:// ref in .env resolves automatically)"
      fi
    fi

    if confirm "Rotate PostgreSQL password?"; then
      info "Generating new PostgreSQL password..."
      NEW_PG_PASS=$(op generate-password --length=32 --no-symbols 2>/dev/null || openssl rand -base64 24)
      op item edit "PostgreSQL" --vault "$VAULT_NAME" "password=$NEW_PG_PASS" >/dev/null 2>&1 || \
        warn "Could not update 1Password item 'PostgreSQL'"
      warn "PostgreSQL password changed. You must recreate the postgres volume:"
      echo "  op run --env-file=.env -- $COMPOSE down -v && op run --env-file=.env -- $COMPOSE up -d"
      ok "PostgreSQL password updated in 1Password (op:// ref in .env resolves automatically)"
    fi
  fi

  # -- Assistant name --
  echo ""
  ask "Assistant name [${ASSISTANT_NAME:-Nano}]:"
  read -r NEW_NAME
  if [[ -n "$NEW_NAME" ]]; then
    sed -i.bak "s/^ASSISTANT_NAME=.*/ASSISTANT_NAME=$NEW_NAME/" .env && rm -f .env.bak
    ok "Assistant name updated: $NEW_NAME"
  fi

  # -- Orchestrator model --
  echo ""
  echo "Current orchestrator model: ${ORCHESTRATOR_MODEL:-not set}"
  echo ""
  echo "  1) anthropic/claude-sonnet-4-20250514"
  echo "  2) openai/gpt-4o"
  echo "  3) google/gemini-2.5-pro-preview-06-05"
  echo "  4) deepseek/deepseek-chat"
  echo "  5) meta-llama/llama-4-maverick"
  echo "  6) Custom model ID"
  echo "  7) Keep current"
  echo ""
  ask "Orchestrator model [7]:"
  read -r M_CHOICE
  case "${M_CHOICE:-7}" in
    1) NEW_ORCH="anthropic/claude-sonnet-4-20250514" ;;
    2) NEW_ORCH="openai/gpt-4o" ;;
    3) NEW_ORCH="google/gemini-2.5-pro-preview-06-05" ;;
    4) NEW_ORCH="deepseek/deepseek-chat" ;;
    5) NEW_ORCH="meta-llama/llama-4-maverick" ;;
    6) ask "Enter model ID:"; read -r NEW_ORCH ;;
    7) NEW_ORCH="" ;;
    *) NEW_ORCH="" ;;
  esac
  if [[ -n "$NEW_ORCH" ]]; then
    sed -i.bak "s|^ORCHESTRATOR_MODEL=.*|ORCHESTRATOR_MODEL=$NEW_ORCH|" .env && rm -f .env.bak
    ok "Orchestrator model updated: $NEW_ORCH"
  fi

  # -- Default specialist model --
  echo ""
  echo "Current default specialist model: ${DEFAULT_AGENT_MODEL:-not set}"
  echo ""
  echo "  1) Same as orchestrator"
  echo "  2) anthropic/claude-sonnet-4-20250514"
  echo "  3) openai/gpt-4o"
  echo "  4) deepseek/deepseek-chat"
  echo "  5) google/gemini-2.0-flash-001"
  echo "  6) Custom model ID"
  echo "  7) Keep current"
  echo ""
  ask "Default specialist model [7]:"
  read -r A_CHOICE
  case "${A_CHOICE:-7}" in
    1) NEW_AGENT="${NEW_ORCH:-$ORCHESTRATOR_MODEL}" ;;
    2) NEW_AGENT="anthropic/claude-sonnet-4-20250514" ;;
    3) NEW_AGENT="openai/gpt-4o" ;;
    4) NEW_AGENT="deepseek/deepseek-chat" ;;
    5) NEW_AGENT="google/gemini-2.0-flash-001" ;;
    6) ask "Enter model ID:"; read -r NEW_AGENT ;;
    7) NEW_AGENT="" ;;
    *) NEW_AGENT="" ;;
  esac
  if [[ -n "$NEW_AGENT" ]]; then
    sed -i.bak "s|^DEFAULT_AGENT_MODEL=.*|DEFAULT_AGENT_MODEL=$NEW_AGENT|" .env && rm -f .env.bak
    ok "Default specialist model updated: $NEW_AGENT"
  fi

  # -- Embedding model --
  echo ""
  echo "Current embedding model: ${EMBEDDING_MODEL:-not set}"
  if confirm "Change embedding model?"; then
    echo "  1) openai/text-embedding-3-small"
    echo "  2) openai/text-embedding-3-large"
    echo "  3) Custom"
    ask "Choice [1]:"
    read -r E_CHOICE
    case "${E_CHOICE:-1}" in
      1) NEW_EMBED="openai/text-embedding-3-small" ;;
      2) NEW_EMBED="openai/text-embedding-3-large" ;;
      3) ask "Enter model ID:"; read -r NEW_EMBED ;;
      *) NEW_EMBED="" ;;
    esac
    if [[ -n "$NEW_EMBED" ]]; then
      sed -i.bak "s|^EMBEDDING_MODEL=.*|EMBEDDING_MODEL=$NEW_EMBED|" .env && rm -f .env.bak
      ok "Embedding model updated: $NEW_EMBED"
    fi
  fi

  # -- Advanced --
  echo ""
  if confirm "Reconfigure advanced settings?"; then
    ask "Orchestrator TTL in hours [$(( ${ORCHESTRATOR_TTL:-28800000} / 3600000 ))]:"
    read -r TTL_H
    if [[ -n "$TTL_H" ]]; then
      sed -i.bak "s/^ORCHESTRATOR_TTL=.*/ORCHESTRATOR_TTL=$(( TTL_H * 3600000 ))/" .env && rm -f .env.bak
    fi

    ask "Idle timeout in minutes [$(( ${IDLE_TIMEOUT:-1800000} / 60000 ))]:"
    read -r IDLE_M
    if [[ -n "$IDLE_M" ]]; then
      sed -i.bak "s/^IDLE_TIMEOUT=.*/IDLE_TIMEOUT=$(( IDLE_M * 60000 ))/" .env && rm -f .env.bak
    fi

    ask "Max concurrent containers [${MAX_CONCURRENT_CONTAINERS:-5}]:"
    read -r MAX_C
    if [[ -n "$MAX_C" ]]; then
      sed -i.bak "s/^MAX_CONCURRENT_CONTAINERS=.*/MAX_CONCURRENT_CONTAINERS=$MAX_C/" .env && rm -f .env.bak
    fi

    ask "Log level [${LOG_LEVEL:-info}]:"
    read -r LVL
    if [[ -n "$LVL" ]]; then
      sed -i.bak "s/^LOG_LEVEL=.*/LOG_LEVEL=$LVL/" .env && rm -f .env.bak
    fi
  fi

  ok "Reconfiguration complete"
fi

# ── MCP Server Setup ──────────────────────────────────────────────

# Helper: find a readable field on a 1Password item
find_op_field() {
  local vault="$1" item="$2"
  shift 2
  local field
  for field in "$@"; do
    [[ -z "$field" ]] && continue
    if op read "op://${vault}/${item}/${field}" &>/dev/null; then
      echo "$field"
      return 0
    fi
  done
  return 1
}

# Helper: create a 1Password item with category fallback
create_1password_item() {
  local vault="$1" title="$2" category_hint="$3"
  shift 3

  local -a category_candidates=()
  case "$category_hint" in
    api-credential|API\ Credential)
      category_candidates=("API Credential" "api-credential") ;;
    *)
      category_candidates=("$category_hint") ;;
  esac

  local category
  for category in "${category_candidates[@]}"; do
    if op item create --category="$category" --vault="$vault" --title="$title" "$@" >/dev/null; then
      return 0
    fi
  done
  return 1
}

if [[ "$SETUP_MCP" == true ]]; then
  header "MCP Server Setup"

  # Read vault name from .env
  VAULT_NAME="$(grep '^OP_VAULT=' .env 2>/dev/null | cut -d= -f2- || echo "Astrobot")"
  VAULT_NAME="${VAULT_NAME:-Astrobot}"
  info "Using 1Password vault: $VAULT_NAME"

  if ! op whoami &>/dev/null 2>&1; then
    warn "1Password CLI is not signed in. Run: eval \$(op signin)"
    warn "Skipping MCP setup."
  else
    echo ""
    echo "Configure MCP server integrations for your agents."
    echo "Already-configured servers will be detected and skipped."
    echo ""

    MCP_CHANGED=false

    # -- Slack --
    CURRENT_SLACK="$(grep '^SLACK_BOT_TOKEN=' .env 2>/dev/null | cut -d= -f2-)" || true
    if [[ -n "$CURRENT_SLACK" ]]; then
      ok "Slack: already configured"
    elif confirm "Set up Slack?"; then
      ITEM_NAME="Slack Bot"
      if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
        ok "1Password item '$ITEM_NAME' already exists"
        SLACK_TOKEN_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "token" "credential" "password")" || true
        SLACK_TEAM_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "team id" "team_id")" || true
        if [[ -n "${SLACK_TOKEN_FIELD:-}" && -n "${SLACK_TEAM_FIELD:-}" ]]; then
          # Check if vars already exist in .env (possibly empty)
          if grep -q '^SLACK_BOT_TOKEN=' .env 2>/dev/null; then
            sed -i.bak "s|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=op://$VAULT_NAME/$ITEM_NAME/$SLACK_TOKEN_FIELD|" .env && rm -f .env.bak
            sed -i.bak "s|^SLACK_TEAM_ID=.*|SLACK_TEAM_ID=op://$VAULT_NAME/$ITEM_NAME/$SLACK_TEAM_FIELD|" .env && rm -f .env.bak
          else
            echo "SLACK_BOT_TOKEN=op://$VAULT_NAME/$ITEM_NAME/$SLACK_TOKEN_FIELD" >> .env
            echo "SLACK_TEAM_ID=op://$VAULT_NAME/$ITEM_NAME/$SLACK_TEAM_FIELD" >> .env
            echo "SLACK_CHANNEL_IDS=" >> .env
          fi
          MCP_CHANGED=true
          ok "Slack configured from existing 1Password item"
        fi
      else
        echo ""
        echo "Create a Slack app: https://api.slack.com/apps → Create New App"
        echo "Required scopes: channels:history, channels:read, chat:write, reactions:write, users:read"
        echo ""
        ask "Slack Bot Token (xoxb-...):"
        read -rs SLACK_TOKEN_VAL
        echo ""
        ask "Slack Team/Workspace ID (starts with T):"
        read -r SLACK_TEAM_VAL
        ask "Channel IDs to expose (comma-separated, optional):"
        read -r SLACK_CHANNELS_VAL

        if [[ -n "${SLACK_TOKEN_VAL:-}" && -n "${SLACK_TEAM_VAL:-}" ]]; then
          create_1password_item "$VAULT_NAME" "Slack Bot" "API Credential" \
            "token=$SLACK_TOKEN_VAL" "team id=$SLACK_TEAM_VAL" || \
            warn "Failed to store Slack credentials"

          if grep -q '^SLACK_BOT_TOKEN=' .env 2>/dev/null; then
            sed -i.bak "s|^SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=op://$VAULT_NAME/Slack Bot/token|" .env && rm -f .env.bak
            sed -i.bak "s|^SLACK_TEAM_ID=.*|SLACK_TEAM_ID=op://$VAULT_NAME/Slack Bot/team id|" .env && rm -f .env.bak
            sed -i.bak "s|^SLACK_CHANNEL_IDS=.*|SLACK_CHANNEL_IDS=${SLACK_CHANNELS_VAL:-}|" .env && rm -f .env.bak
          else
            echo "SLACK_BOT_TOKEN=op://$VAULT_NAME/Slack Bot/token" >> .env
            echo "SLACK_TEAM_ID=op://$VAULT_NAME/Slack Bot/team id" >> .env
            echo "SLACK_CHANNEL_IDS=${SLACK_CHANNELS_VAL:-}" >> .env
          fi
          MCP_CHANGED=true
          ok "Slack credentials stored in 1Password and .env updated"
        else
          warn "Skipping Slack (token or team ID missing)"
        fi
      fi
    fi

    # -- Todoist --
    CURRENT_TODOIST="$(grep '^TODOIST_API_KEY=' .env 2>/dev/null | cut -d= -f2-)" || true
    if [[ -n "$CURRENT_TODOIST" ]]; then
      ok "Todoist: already configured"
    elif confirm "Set up Todoist?"; then
      ITEM_NAME="Todoist"
      if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
        ok "1Password item '$ITEM_NAME' already exists"
        TODOIST_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "api key" "api_key" "credential" "token")" || true
        if [[ -n "${TODOIST_FIELD:-}" ]]; then
          if grep -q '^TODOIST_API_KEY=' .env 2>/dev/null; then
            sed -i.bak "s|^TODOIST_API_KEY=.*|TODOIST_API_KEY=op://$VAULT_NAME/$ITEM_NAME/$TODOIST_FIELD|" .env && rm -f .env.bak
          else
            echo "TODOIST_API_KEY=op://$VAULT_NAME/$ITEM_NAME/$TODOIST_FIELD" >> .env
          fi
          MCP_CHANGED=true
          ok "Todoist configured from existing 1Password item"
        fi
      else
        echo ""
        echo "Get your API token: Todoist Settings → Integrations → Developer"
        echo ""
        ask "Todoist API Key:"
        read -rs TODOIST_KEY_VAL
        echo ""
        if [[ -n "${TODOIST_KEY_VAL:-}" ]]; then
          create_1password_item "$VAULT_NAME" "Todoist" "API Credential" \
            "api key=$TODOIST_KEY_VAL" || warn "Failed to store Todoist credentials"

          if grep -q '^TODOIST_API_KEY=' .env 2>/dev/null; then
            sed -i.bak "s|^TODOIST_API_KEY=.*|TODOIST_API_KEY=op://$VAULT_NAME/Todoist/api key|" .env && rm -f .env.bak
          else
            echo "TODOIST_API_KEY=op://$VAULT_NAME/Todoist/api key" >> .env
          fi
          MCP_CHANGED=true
          ok "Todoist API key stored in 1Password and .env updated"
        else
          warn "Skipping Todoist (no API key provided)"
        fi
      fi
    fi

    # -- Brave Search --
    CURRENT_BRAVE="$(grep '^BRAVE_API_KEY=' .env 2>/dev/null | cut -d= -f2-)" || true
    if [[ -n "$CURRENT_BRAVE" ]]; then
      ok "Brave Search: already configured"
    elif confirm "Set up Brave Search?"; then
      ITEM_NAME="Brave Search"
      if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
        ok "1Password item '$ITEM_NAME' already exists"
        BRAVE_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "api key" "api_key" "credential" "token")" || true
        if [[ -n "${BRAVE_FIELD:-}" ]]; then
          if grep -q '^BRAVE_API_KEY=' .env 2>/dev/null; then
            sed -i.bak "s|^BRAVE_API_KEY=.*|BRAVE_API_KEY=op://$VAULT_NAME/$ITEM_NAME/$BRAVE_FIELD|" .env && rm -f .env.bak
          else
            echo "BRAVE_API_KEY=op://$VAULT_NAME/$ITEM_NAME/$BRAVE_FIELD" >> .env
          fi
          MCP_CHANGED=true
          ok "Brave Search configured from existing 1Password item"
        fi
      else
        echo ""
        echo "Get an API key: https://brave.com/search/api/"
        echo ""
        ask "Brave Search API Key:"
        read -rs BRAVE_KEY_VAL
        echo ""
        if [[ -n "${BRAVE_KEY_VAL:-}" ]]; then
          create_1password_item "$VAULT_NAME" "Brave Search" "API Credential" \
            "api key=$BRAVE_KEY_VAL" || warn "Failed to store Brave Search credentials"

          if grep -q '^BRAVE_API_KEY=' .env 2>/dev/null; then
            sed -i.bak "s|^BRAVE_API_KEY=.*|BRAVE_API_KEY=op://$VAULT_NAME/Brave Search/api key|" .env && rm -f .env.bak
          else
            echo "BRAVE_API_KEY=op://$VAULT_NAME/Brave Search/api key" >> .env
          fi
          MCP_CHANGED=true
          ok "Brave Search API key stored in 1Password and .env updated"
        else
          warn "Skipping Brave Search (no API key provided)"
        fi
      fi
    fi

    # -- Google Workspace --
    CURRENT_GOOGLE="$(grep '^GOOGLE_OAUTH_CLIENT_ID=' .env 2>/dev/null | cut -d= -f2-)" || true
    if [[ -n "$CURRENT_GOOGLE" ]]; then
      ok "Google Workspace: already configured"
    elif confirm "Set up Google Workspace (Gmail, Calendar, Drive, Docs, Sheets)?"; then
      ITEM_NAME="Google Workspace"
      if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
        ok "1Password item '$ITEM_NAME' already exists"
        GOOGLE_CID_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "client id" "client_id")" || true
        GOOGLE_CS_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "client secret" "client_secret")" || true
        if [[ -n "${GOOGLE_CID_FIELD:-}" && -n "${GOOGLE_CS_FIELD:-}" ]]; then
          if grep -q '^GOOGLE_OAUTH_CLIENT_ID=' .env 2>/dev/null; then
            sed -i.bak "s|^GOOGLE_OAUTH_CLIENT_ID=.*|GOOGLE_OAUTH_CLIENT_ID=op://$VAULT_NAME/$ITEM_NAME/$GOOGLE_CID_FIELD|" .env && rm -f .env.bak
            sed -i.bak "s|^GOOGLE_OAUTH_CLIENT_SECRET=.*|GOOGLE_OAUTH_CLIENT_SECRET=op://$VAULT_NAME/$ITEM_NAME/$GOOGLE_CS_FIELD|" .env && rm -f .env.bak
          else
            echo "GOOGLE_OAUTH_CLIENT_ID=op://$VAULT_NAME/$ITEM_NAME/$GOOGLE_CID_FIELD" >> .env
            echo "GOOGLE_OAUTH_CLIENT_SECRET=op://$VAULT_NAME/$ITEM_NAME/$GOOGLE_CS_FIELD" >> .env
          fi
          MCP_CHANGED=true
          ok "Google Workspace configured from existing 1Password item"
        fi
      else
        echo ""
        echo "Set up OAuth credentials:"
        echo "  1. Google Cloud Console → APIs & Services → Credentials"
        echo "  2. Create OAuth Client ID → Desktop Application"
        echo "  3. Enable APIs: Calendar, Drive, Gmail, Docs, Sheets, Slides, Forms, Tasks"
        echo ""
        ask "Google OAuth Client ID:"
        read -r GOOGLE_CID_VAL
        ask "Google OAuth Client Secret:"
        read -rs GOOGLE_CS_VAL
        echo ""

        if [[ -n "${GOOGLE_CID_VAL:-}" && -n "${GOOGLE_CS_VAL:-}" ]]; then
          create_1password_item "$VAULT_NAME" "Google Workspace" "API Credential" \
            "client id=$GOOGLE_CID_VAL" "client secret=$GOOGLE_CS_VAL" || \
            warn "Failed to store Google Workspace credentials"

          if grep -q '^GOOGLE_OAUTH_CLIENT_ID=' .env 2>/dev/null; then
            sed -i.bak "s|^GOOGLE_OAUTH_CLIENT_ID=.*|GOOGLE_OAUTH_CLIENT_ID=op://$VAULT_NAME/Google Workspace/client id|" .env && rm -f .env.bak
            sed -i.bak "s|^GOOGLE_OAUTH_CLIENT_SECRET=.*|GOOGLE_OAUTH_CLIENT_SECRET=op://$VAULT_NAME/Google Workspace/client secret|" .env && rm -f .env.bak
          else
            echo "GOOGLE_OAUTH_CLIENT_ID=op://$VAULT_NAME/Google Workspace/client id" >> .env
            echo "GOOGLE_OAUTH_CLIENT_SECRET=op://$VAULT_NAME/Google Workspace/client secret" >> .env
          fi
          MCP_CHANGED=true
          ok "Google Workspace credentials stored in 1Password and .env updated"
          warn "NOTE: First use requires a one-time OAuth browser authorization"
        else
          warn "Skipping Google Workspace (credentials incomplete)"
        fi
      fi
    fi

    # -- App Store Connect --
    CURRENT_ASC="$(grep '^APP_STORE_CONNECT_KEY_ID=' .env 2>/dev/null | cut -d= -f2-)" || true
    if [[ -n "$CURRENT_ASC" ]]; then
      ok "App Store Connect: already configured"
    elif confirm "Set up App Store Connect (manage apps, beta testers, analytics, sales)?"; then
      ITEM_NAME="App Store Connect"
      if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
        ok "1Password item '$ITEM_NAME' already exists"
        ASC_KEY_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "key id" "key_id")" || true
        ASC_ISSUER_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "issuer id" "issuer_id")" || true
        ASC_P8_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "private key" "p8_key" "p8 key")" || true
        if [[ -n "${ASC_KEY_FIELD:-}" && -n "${ASC_ISSUER_FIELD:-}" ]]; then
          if grep -q '^APP_STORE_CONNECT_KEY_ID=' .env 2>/dev/null; then
            sed -i.bak "s|^APP_STORE_CONNECT_KEY_ID=.*|APP_STORE_CONNECT_KEY_ID=op://$VAULT_NAME/$ITEM_NAME/$ASC_KEY_FIELD|" .env && rm -f .env.bak
            sed -i.bak "s|^APP_STORE_CONNECT_ISSUER_ID=.*|APP_STORE_CONNECT_ISSUER_ID=op://$VAULT_NAME/$ITEM_NAME/$ASC_ISSUER_FIELD|" .env && rm -f .env.bak
            [[ -n "${ASC_P8_FIELD:-}" ]] && sed -i.bak "s|^APP_STORE_CONNECT_P8_KEY=.*|APP_STORE_CONNECT_P8_KEY=op://$VAULT_NAME/$ITEM_NAME/$ASC_P8_FIELD|" .env && rm -f .env.bak
          else
            echo "APP_STORE_CONNECT_KEY_ID=op://$VAULT_NAME/$ITEM_NAME/$ASC_KEY_FIELD" >> .env
            echo "APP_STORE_CONNECT_ISSUER_ID=op://$VAULT_NAME/$ITEM_NAME/$ASC_ISSUER_FIELD" >> .env
            [[ -n "${ASC_P8_FIELD:-}" ]] && echo "APP_STORE_CONNECT_P8_KEY=op://$VAULT_NAME/$ITEM_NAME/$ASC_P8_FIELD" >> .env
            echo "APP_STORE_CONNECT_VENDOR_NUMBER=" >> .env
          fi
          MCP_CHANGED=true
          ok "App Store Connect configured from existing 1Password item"
        fi
      else
        echo ""
        echo "Generate an App Store Connect API key:"
        echo "  1. App Store Connect → Users and Access → Integrations → Keys"
        echo "  2. Click '+' to generate a new API key"
        echo "  3. Download the .p8 private key file"
        echo "  4. Note your Key ID and Issuer ID"
        echo ""
        ask "API Key ID:"
        read -r ASC_KEY_VAL
        ask "Issuer ID:"
        read -r ASC_ISSUER_VAL
        echo ""
        echo "Paste the contents of your .p8 private key file below."
        echo "  (Open the file with: cat /path/to/AuthKey_XXXXXXXXXX.p8)"
        echo "  Paste all lines including -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY-----"
        echo "  Press Enter on an empty line when done:"
        ASC_P8_VAL=""
        while IFS= read -r line; do
          [[ -z "$line" ]] && break
          if [[ -z "$ASC_P8_VAL" ]]; then
            ASC_P8_VAL="$line"
          else
            ASC_P8_VAL="$ASC_P8_VAL
$line"
          fi
        done
        echo ""
        ask "Vendor Number (optional, for sales/finance reports):"
        read -r ASC_VENDOR_VAL

        if [[ -n "${ASC_KEY_VAL:-}" && -n "${ASC_ISSUER_VAL:-}" && -n "${ASC_P8_VAL:-}" ]]; then
          local_fields=("key id=$ASC_KEY_VAL" "issuer id=$ASC_ISSUER_VAL" "private key=$ASC_P8_VAL")
          [[ -n "${ASC_VENDOR_VAL:-}" ]] && local_fields+=("vendor number=$ASC_VENDOR_VAL")
          create_1password_item "$VAULT_NAME" "App Store Connect" "API Credential" \
            "${local_fields[@]}" || warn "Failed to store App Store Connect credentials"

          if grep -q '^APP_STORE_CONNECT_KEY_ID=' .env 2>/dev/null; then
            sed -i.bak "s|^APP_STORE_CONNECT_KEY_ID=.*|APP_STORE_CONNECT_KEY_ID=op://$VAULT_NAME/App Store Connect/key id|" .env && rm -f .env.bak
            sed -i.bak "s|^APP_STORE_CONNECT_ISSUER_ID=.*|APP_STORE_CONNECT_ISSUER_ID=op://$VAULT_NAME/App Store Connect/issuer id|" .env && rm -f .env.bak
            sed -i.bak "s|^APP_STORE_CONNECT_P8_KEY=.*|APP_STORE_CONNECT_P8_KEY=op://$VAULT_NAME/App Store Connect/private key|" .env && rm -f .env.bak
          else
            echo "APP_STORE_CONNECT_KEY_ID=op://$VAULT_NAME/App Store Connect/key id" >> .env
            echo "APP_STORE_CONNECT_ISSUER_ID=op://$VAULT_NAME/App Store Connect/issuer id" >> .env
            echo "APP_STORE_CONNECT_P8_KEY=op://$VAULT_NAME/App Store Connect/private key" >> .env
            echo "APP_STORE_CONNECT_VENDOR_NUMBER=${ASC_VENDOR_VAL:-}" >> .env
          fi
          MCP_CHANGED=true
          ok "App Store Connect credentials stored in 1Password and .env updated"
        else
          warn "Skipping App Store Connect (Key ID, Issuer ID, or private key missing)"
        fi
      fi
    fi

    # Playwright — always available
    ok "Playwright browser automation: always enabled (no credentials needed)"

    echo ""
    if [[ "$MCP_CHANGED" == true ]]; then
      ok "MCP configuration updated. Changes take effect on next restart."
    else
      info "No MCP changes made."
    fi
  fi
fi

# ── Install dependencies ───────────────────────────────────────────

if [[ "$SKIP_DEPS" == false ]]; then
  header "Installing dependencies"
  npm ci
  ok "Dependencies installed"
else
  info "Skipping dependency install (--no-deps)"
fi

# ── Build agent container ──────────────────────────────────────────

if [[ "$SKIP_BUILD" == false ]]; then
  header "Rebuilding agent container"
  bash ./container/build.sh
  ok "Agent container rebuilt"
else
  info "Skipping container build (--no-build)"
fi

# ── Build host service ─────────────────────────────────────────────

header "Building host service"
npm run build
ok "TypeScript compiled"

# ── Restart services ───────────────────────────────────────────────

header "Restarting services"

verify_op_auth

# Check if services are running
if op_compose ps --status running 2>/dev/null | grep -q postgres; then
  info "PostgreSQL is running — keeping it up"
else
  info "Starting PostgreSQL..."
  op_compose up -d postgres

  info "Waiting for PostgreSQL..."
  RETRIES=30
  until op_compose exec -T postgres pg_isready -U astrobot &>/dev/null || [[ $RETRIES -eq 0 ]]; do
    sleep 1
    ((RETRIES--))
  done

  if [[ $RETRIES -eq 0 ]]; then
    err "PostgreSQL failed to start."
    exit 1
  fi
  ok "PostgreSQL ready"
fi

info "Restarting Astrobot..."
op_compose up -d --build astrobot
ok "Astrobot restarted"

# ── Health check ───────────────────────────────────────────────────

header "Health check"

sleep 3

if op_compose ps --status running 2>/dev/null | grep -q astrobot; then
  ok "Astrobot is running"
else
  # Fallback check for older docker-compose
  if op_compose ps 2>/dev/null | grep -q "Up"; then
    ok "Astrobot is running"
  else
    warn "Astrobot may not be running. Check logs:"
    echo "  op run --env-file=.env -- $COMPOSE logs --tail=50 astrobot"
  fi
fi

# ── Done ───────────────────────────────────────────────────────────

header "Update complete"

# Re-source .env to show current values
source <(grep -v '^\s*#' .env | grep '=' | sed 's/^\([^=]*\)=\(.*\)/export \1="\2"/' 2>/dev/null) 2>/dev/null || true

echo ""
echo -e "${GREEN}${BOLD}Astrobot v2 updated successfully!${NC}"
echo ""
echo "  Assistant:           ${ASSISTANT_NAME:-Nano}"
echo "  Orchestrator model:  ${ORCHESTRATOR_MODEL:-not set}"
echo "  Default agent model: ${DEFAULT_AGENT_MODEL:-not set}"
echo ""

# Show configured MCP servers
MCP_LIST=("Playwright")
grep -q '^SLACK_BOT_TOKEN=.\+' .env 2>/dev/null && MCP_LIST+=("Slack")
grep -q '^TODOIST_API_KEY=.\+' .env 2>/dev/null && MCP_LIST+=("Todoist")
grep -q '^BRAVE_API_KEY=.\+' .env 2>/dev/null && MCP_LIST+=("Brave Search")
grep -q '^GOOGLE_OAUTH_CLIENT_ID=.\+' .env 2>/dev/null && MCP_LIST+=("Google Workspace")
grep -q '^APP_STORE_CONNECT_KEY_ID=.\+' .env 2>/dev/null && MCP_LIST+=("App Store Connect")
echo "  MCP servers:         ${MCP_LIST[*]}"
echo ""

echo "Commands:"
echo "  op run --env-file=.env -- $COMPOSE logs -f astrobot    # View logs"
echo "  op run --env-file=.env -- $COMPOSE restart astrobot    # Restart"
echo "  ./scripts/update.sh --reconfigure                      # Change models/settings"
echo "  ./scripts/update.sh --setup-mcp                        # Configure MCP servers"
echo ""
