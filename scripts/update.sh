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

# ── Pre-flight ──────────────────────────────────────────────────────

header "Astrobot Update"

if [[ ! -f .env ]]; then
  err ".env not found. Run ./scripts/deploy.sh for first-time setup."
  exit 1
fi

# Source current config for display
source <(grep -v '^\s*#' .env | grep '=' | sed 's/^/export /')

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
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-git)     SKIP_GIT=true ;;
    --no-deps)    SKIP_DEPS=true ;;
    --no-build)   SKIP_BUILD=true ;;
    --reconfigure) RECONFIGURE=true ;;
    --force|-f)   FORCE=true ;;
    --help|-h)
      echo "Usage: ./scripts/update.sh [options]"
      echo ""
      echo "Options:"
      echo "  --no-git        Skip git pull"
      echo "  --no-deps       Skip npm install"
      echo "  --no-build      Skip container rebuild"
      echo "  --reconfigure   Re-run model/name/credential configuration"
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

  VAULT_NAME="Astrobot"

  # Check 1Password sign-in
  if ! op whoami &>/dev/null 2>&1; then
    warn "1Password CLI is not signed in. Run: eval \$(op signin)"
    warn "Skipping credential reconfiguration."
  else
    # -- Rotate credentials? --
    echo ""
    if confirm "Rotate Telegram bot token?"; then
      ask "New Telegram Bot Token:"
      read -rs NEW_TOKEN
      echo ""
      if [[ -n "$NEW_TOKEN" ]]; then
        op item edit "Telegram Bot" --vault "$VAULT_NAME" "token=$NEW_TOKEN" >/dev/null 2>&1 || \
          op item create --category=api-credential --vault="$VAULT_NAME" --title="Telegram Bot" "token=$NEW_TOKEN" >/dev/null
        # Update .env with the new resolved value
        sed -i.bak "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$NEW_TOKEN|" .env && rm -f .env.bak
        ok "Telegram token updated in 1Password and .env"
      fi
    fi

    if confirm "Rotate OpenRouter API key?"; then
      ask "New OpenRouter API Key:"
      read -rs NEW_KEY
      echo ""
      if [[ -n "$NEW_KEY" ]]; then
        op item edit "OpenRouter" --vault "$VAULT_NAME" "api key=$NEW_KEY" >/dev/null 2>&1 || \
          op item create --category=api-credential --vault="$VAULT_NAME" --title="OpenRouter" "api key=$NEW_KEY" >/dev/null
        # Update .env with the new resolved value
        sed -i.bak "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=$NEW_KEY|" .env && rm -f .env.bak
        ok "OpenRouter key updated in 1Password and .env"
      fi
    fi

    if confirm "Rotate PostgreSQL password?"; then
      info "Generating new PostgreSQL password..."
      NEW_PG_PASS=$(op generate-password --length=32 --no-symbols 2>/dev/null || openssl rand -base64 24)
      op item edit "PostgreSQL" --vault "$VAULT_NAME" "password=$NEW_PG_PASS" >/dev/null 2>&1 || \
        warn "Could not update 1Password item"
      # Update .env
      sed -i.bak "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$NEW_PG_PASS|" .env && rm -f .env.bak
      sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://astrobot:${NEW_PG_PASS}@postgres:5432/astrobot|" .env && rm -f .env.bak
      warn "PostgreSQL password changed. You must recreate the postgres volume:"
      echo "  $COMPOSE down -v && $COMPOSE up -d"
      ok "PostgreSQL password updated"
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

# Check if services are running
if $COMPOSE ps --status running 2>/dev/null | grep -q postgres; then
  info "PostgreSQL is running — keeping it up"
else
  info "Starting PostgreSQL..."
  $COMPOSE up -d postgres

  info "Waiting for PostgreSQL..."
  RETRIES=30
  until $COMPOSE exec -T postgres pg_isready -U astrobot &>/dev/null || [[ $RETRIES -eq 0 ]]; do
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
$COMPOSE up -d --build astrobot
ok "Astrobot restarted"

# ── Health check ───────────────────────────────────────────────────

header "Health check"

sleep 3

if $COMPOSE ps --status running 2>/dev/null | grep -q astrobot; then
  ok "Astrobot is running"
else
  # Fallback check for older docker-compose
  if $COMPOSE ps 2>/dev/null | grep -q "Up"; then
    ok "Astrobot is running"
  else
    warn "Astrobot may not be running. Check logs:"
    echo "  $COMPOSE logs --tail=50 astrobot"
  fi
fi

# ── Done ───────────────────────────────────────────────────────────

header "Update complete"

# Re-source .env to show current values
source <(grep -v '^\s*#' .env | grep '=' | sed 's/^/export /' 2>/dev/null) 2>/dev/null || true

echo ""
echo -e "${GREEN}${BOLD}Astrobot v2 updated successfully!${NC}"
echo ""
echo "  Assistant:           ${ASSISTANT_NAME:-Nano}"
echo "  Orchestrator model:  ${ORCHESTRATOR_MODEL:-not set}"
echo "  Default agent model: ${DEFAULT_AGENT_MODEL:-not set}"
echo ""
echo "Commands:"
echo "  $COMPOSE logs -f astrobot       # View logs"
echo "  $COMPOSE restart astrobot       # Restart"
echo "  ./scripts/update.sh --reconfigure  # Change models/settings"
echo ""
