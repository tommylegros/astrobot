#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Astrobot v2 — First-Time Deploy Script
#
# Handles:
#   1. System dependency checks (Docker, Node, 1Password CLI)
#   2. 1Password vault + item creation for all secrets
#   3. .env generation with op:// references only
#   4. Bot customization (name, models, timeouts)
#   5. Agent container build
#   6. PostgreSQL + app startup via docker-compose
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

# ── Helpers ─────────────────────────────────────────────────────────

confirm() {
  local prompt="${1:-Continue?}"
  ask "$prompt [Y/n]"
  read -r answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    err "$1 is not installed."
    echo "  $2"
    exit 1
  fi
}

# ── Pre-flight checks ──────────────────────────────────────────────

header "Pre-flight checks"

require_cmd docker "Install Docker: https://docs.docker.com/engine/install/"
ok "Docker found: $(docker --version | head -1)"

require_cmd docker "Docker Compose is required (bundled with Docker Desktop or install docker-compose-plugin)"
if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
  ok "Docker Compose found: $(docker compose version --short)"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
  ok "Docker Compose found: $(docker-compose version --short)"
else
  err "Docker Compose not found. Install: https://docs.docker.com/compose/install/"
  exit 1
fi

require_cmd node "Install Node.js 20+: https://nodejs.org/"
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 20 ]]; then
  err "Node.js 20+ required (found v$(node -v))"
  exit 1
fi
ok "Node.js found: $(node -v)"

require_cmd op "Install 1Password CLI: https://developer.1password.com/docs/cli/get-started/"
ok "1Password CLI found: $(op --version)"

# Check 1Password sign-in
if ! op whoami &>/dev/null 2>&1; then
  warn "1Password CLI is not signed in."
  info "Sign in now:"
  echo ""
  echo "  eval \$(op signin)"
  echo ""
  info "Then re-run this script."
  exit 1
fi
OP_ACCOUNT=$(op whoami --format=json 2>/dev/null | grep -o '"email":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
ok "1Password signed in as: $OP_ACCOUNT"

# ── 1Password vault setup ──────────────────────────────────────────

header "1Password vault setup"

VAULT_NAME="Astrobot"

if op vault get "$VAULT_NAME" &>/dev/null 2>&1; then
  ok "Vault '$VAULT_NAME' already exists"
else
  info "Creating vault '$VAULT_NAME'..."
  op vault create "$VAULT_NAME" --description "Astrobot AI assistant credentials" >/dev/null
  ok "Vault '$VAULT_NAME' created"
fi

# ── Collect credentials ────────────────────────────────────────────

header "Credential setup"

echo "All secrets will be stored in 1Password and referenced via op:// URIs."
echo "Your .env file will NEVER contain raw secrets."
echo ""

# -- Telegram Bot Token --
ITEM_NAME="Telegram Bot"
if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
  ok "1Password item '$ITEM_NAME' already exists"
  TELEGRAM_REF="op://$VAULT_NAME/$ITEM_NAME/token"
else
  echo "You need a Telegram bot token from @BotFather (https://t.me/BotFather)."
  ask "Telegram Bot Token:"
  read -rs TELEGRAM_TOKEN
  echo ""

  if [[ -z "$TELEGRAM_TOKEN" ]]; then
    err "Telegram bot token is required."
    exit 1
  fi

  op item create \
    --category=api-credential \
    --vault="$VAULT_NAME" \
    --title="$ITEM_NAME" \
    "token=$TELEGRAM_TOKEN" >/dev/null

  ok "Stored Telegram bot token in 1Password"
  TELEGRAM_REF="op://$VAULT_NAME/$ITEM_NAME/token"
fi

# -- OpenRouter API Key --
ITEM_NAME="OpenRouter"
if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
  ok "1Password item '$ITEM_NAME' already exists"
  OPENROUTER_REF="op://$VAULT_NAME/$ITEM_NAME/api key"
else
  echo "You need an OpenRouter API key from https://openrouter.ai/keys"
  ask "OpenRouter API Key:"
  read -rs OPENROUTER_KEY
  echo ""

  if [[ -z "$OPENROUTER_KEY" ]]; then
    err "OpenRouter API key is required."
    exit 1
  fi

  op item create \
    --category=api-credential \
    --vault="$VAULT_NAME" \
    --title="$ITEM_NAME" \
    "api key=$OPENROUTER_KEY" >/dev/null

  ok "Stored OpenRouter API key in 1Password"
  OPENROUTER_REF="op://$VAULT_NAME/$ITEM_NAME/api key"
fi

# -- Postgres Password --
ITEM_NAME="PostgreSQL"
if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
  ok "1Password item '$ITEM_NAME' already exists"
  POSTGRES_REF="op://$VAULT_NAME/$ITEM_NAME/password"
else
  info "Generating a secure PostgreSQL password..."
  PG_PASSWORD=$(op generate-password --length=32 --no-symbols 2>/dev/null || openssl rand -base64 24)

  op item create \
    --category=database \
    --vault="$VAULT_NAME" \
    --title="$ITEM_NAME" \
    "password=$PG_PASSWORD" \
    "username=astrobot" \
    "database=astrobot" \
    "hostname=postgres" \
    "port=5432" >/dev/null

  ok "Stored PostgreSQL credentials in 1Password"
  POSTGRES_REF="op://$VAULT_NAME/$ITEM_NAME/password"
fi

# ── Bot customization ──────────────────────────────────────────────

header "Bot customization"

# -- Assistant name --
ask "Assistant name [Nano]:"
read -r ASSISTANT_NAME
ASSISTANT_NAME="${ASSISTANT_NAME:-Nano}"
ok "Assistant name: $ASSISTANT_NAME"

# -- Orchestrator model --
echo ""
echo "Choose the model for the orchestrator (main) agent."
echo "This is the model that handles all your messages and delegates to specialists."
echo ""
echo "Popular options:"
echo "  1) anthropic/claude-sonnet-4-20250514  (Claude Sonnet 4)"
echo "  2) openai/gpt-4o                       (GPT-4o)"
echo "  3) google/gemini-2.5-pro-preview-06-05 (Gemini 2.5 Pro)"
echo "  4) deepseek/deepseek-chat              (DeepSeek V3)"
echo "  5) meta-llama/llama-4-maverick         (Llama 4 Maverick)"
echo "  6) Custom (enter OpenRouter model ID)"
echo ""
ask "Orchestrator model [1]:"
read -r MODEL_CHOICE
case "${MODEL_CHOICE:-1}" in
  1) ORCHESTRATOR_MODEL="anthropic/claude-sonnet-4-20250514" ;;
  2) ORCHESTRATOR_MODEL="openai/gpt-4o" ;;
  3) ORCHESTRATOR_MODEL="google/gemini-2.5-pro-preview-06-05" ;;
  4) ORCHESTRATOR_MODEL="deepseek/deepseek-chat" ;;
  5) ORCHESTRATOR_MODEL="meta-llama/llama-4-maverick" ;;
  6)
    ask "Enter OpenRouter model ID:"
    read -r ORCHESTRATOR_MODEL
    if [[ -z "$ORCHESTRATOR_MODEL" ]]; then
      err "Model ID cannot be empty."
      exit 1
    fi
    ;;
  *) ORCHESTRATOR_MODEL="anthropic/claude-sonnet-4-20250514" ;;
esac
ok "Orchestrator model: $ORCHESTRATOR_MODEL"

# -- Default specialist model --
echo ""
echo "Choose the default model for new specialist agents."
echo "(You can override per-agent later via the orchestrator.)"
echo ""
echo "  1) Same as orchestrator ($ORCHESTRATOR_MODEL)"
echo "  2) anthropic/claude-sonnet-4-20250514"
echo "  3) openai/gpt-4o"
echo "  4) deepseek/deepseek-chat"
echo "  5) google/gemini-2.0-flash-001  (fast + cheap)"
echo "  6) Custom (enter OpenRouter model ID)"
echo ""
ask "Default specialist model [1]:"
read -r AGENT_CHOICE
case "${AGENT_CHOICE:-1}" in
  1) DEFAULT_AGENT_MODEL="$ORCHESTRATOR_MODEL" ;;
  2) DEFAULT_AGENT_MODEL="anthropic/claude-sonnet-4-20250514" ;;
  3) DEFAULT_AGENT_MODEL="openai/gpt-4o" ;;
  4) DEFAULT_AGENT_MODEL="deepseek/deepseek-chat" ;;
  5) DEFAULT_AGENT_MODEL="google/gemini-2.0-flash-001" ;;
  6)
    ask "Enter OpenRouter model ID:"
    read -r DEFAULT_AGENT_MODEL
    if [[ -z "$DEFAULT_AGENT_MODEL" ]]; then
      DEFAULT_AGENT_MODEL="$ORCHESTRATOR_MODEL"
    fi
    ;;
  *) DEFAULT_AGENT_MODEL="$ORCHESTRATOR_MODEL" ;;
esac
ok "Default specialist model: $DEFAULT_AGENT_MODEL"

# -- Embedding model --
echo ""
echo "Choose the embedding model for vector memory."
echo ""
echo "  1) openai/text-embedding-3-small  (recommended, 1536d)"
echo "  2) openai/text-embedding-3-large  (higher quality, 3072d)"
echo "  3) Custom (enter OpenRouter model ID)"
echo ""
ask "Embedding model [1]:"
read -r EMBED_CHOICE
case "${EMBED_CHOICE:-1}" in
  1) EMBEDDING_MODEL="openai/text-embedding-3-small" ;;
  2) EMBEDDING_MODEL="openai/text-embedding-3-large" ;;
  3)
    ask "Enter OpenRouter model ID:"
    read -r EMBEDDING_MODEL
    if [[ -z "$EMBEDDING_MODEL" ]]; then
      EMBEDDING_MODEL="openai/text-embedding-3-small"
    fi
    ;;
  *) EMBEDDING_MODEL="openai/text-embedding-3-small" ;;
esac
ok "Embedding model: $EMBEDDING_MODEL"

# -- Advanced settings --
echo ""
if confirm "Configure advanced settings (timeouts, concurrency)?"; then
  echo ""
  ask "Orchestrator TTL in hours [8]:"
  read -r ORCH_TTL_HOURS
  ORCH_TTL_HOURS="${ORCH_TTL_HOURS:-8}"
  ORCHESTRATOR_TTL=$(( ORCH_TTL_HOURS * 3600000 ))

  ask "Idle timeout in minutes [30]:"
  read -r IDLE_MIN
  IDLE_MIN="${IDLE_MIN:-30}"
  IDLE_TIMEOUT=$(( IDLE_MIN * 60000 ))

  ask "Max concurrent agent containers [5]:"
  read -r MAX_CONTAINERS
  MAX_CONTAINERS="${MAX_CONTAINERS:-5}"

  ask "Log level (trace/debug/info/warn/error) [info]:"
  read -r LOG_LEVEL
  LOG_LEVEL="${LOG_LEVEL:-info}"
else
  ORCHESTRATOR_TTL=28800000
  IDLE_TIMEOUT=1800000
  MAX_CONTAINERS=5
  LOG_LEVEL="info"
fi

ok "Advanced settings configured"

# ── Generate .env ───────────────────────────────────────────────────

header "Generating .env"

if [[ -f .env ]]; then
  warn ".env already exists — backing up to .env.backup.$(date +%s)"
  cp .env ".env.backup.$(date +%s)"
fi

# Resolve secrets for docker-compose (it can't read op:// references natively)
info "Resolving secrets from 1Password..."
TELEGRAM_RESOLVED=$(op read "$TELEGRAM_REF" 2>/dev/null)
OPENROUTER_RESOLVED=$(op read "$OPENROUTER_REF" 2>/dev/null)
PG_PASS_RESOLVED=$(op read "$POSTGRES_REF" 2>/dev/null)
ok "Secrets resolved"

cat > .env << ENVEOF
# ─────────────────────────────────────────────────────────────────────
# Astrobot v2 — Generated by deploy.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# Secrets are stored in 1Password (vault: $VAULT_NAME).
# This file contains resolved values for docker-compose.
# To rotate credentials, use: ./scripts/update.sh --reconfigure
#
# 1Password references:
#   Telegram:   $TELEGRAM_REF
#   OpenRouter: $OPENROUTER_REF
#   Postgres:   $POSTGRES_REF
# ─────────────────────────────────────────────────────────────────────

# ── Secrets ─────────────────────────────────────────────────────────

TELEGRAM_BOT_TOKEN=$TELEGRAM_RESOLVED
OPENROUTER_API_KEY=$OPENROUTER_RESOLVED
POSTGRES_PASSWORD=$PG_PASS_RESOLVED

# ── Database ────────────────────────────────────────────────────────

DATABASE_URL=postgresql://astrobot:${PG_PASS_RESOLVED}@postgres:5432/astrobot

# ── Bot Configuration ───────────────────────────────────────────────

ASSISTANT_NAME=$ASSISTANT_NAME
ORCHESTRATOR_MODEL=$ORCHESTRATOR_MODEL
DEFAULT_AGENT_MODEL=$DEFAULT_AGENT_MODEL
EMBEDDING_MODEL=$EMBEDDING_MODEL

# ── Container Settings ──────────────────────────────────────────────

CONTAINER_IMAGE=astrobot-agent:latest
ORCHESTRATOR_TTL=$ORCHESTRATOR_TTL
IDLE_TIMEOUT=$IDLE_TIMEOUT
MAX_CONCURRENT_CONTAINERS=$MAX_CONTAINERS

# ── Logging ─────────────────────────────────────────────────────────

LOG_LEVEL=$LOG_LEVEL
ENVEOF

# Lock down .env permissions — it contains resolved secrets
chmod 600 .env

ok ".env generated with 1Password references"

# ── Install dependencies ───────────────────────────────────────────

header "Installing dependencies"

npm ci
ok "Node.js dependencies installed"

# ── Build agent container ──────────────────────────────────────────

header "Building agent container"

bash ./container/build.sh
ok "Agent container image built"

# ── Build host service ─────────────────────────────────────────────

header "Building host service"

npm run build
ok "TypeScript compiled"

# ── Start services ─────────────────────────────────────────────────

header "Starting services"

info "Starting PostgreSQL..."
$COMPOSE up -d postgres

# Wait for postgres to be healthy
info "Waiting for PostgreSQL to be ready..."
RETRIES=30
until $COMPOSE exec -T postgres pg_isready -U astrobot &>/dev/null || [[ $RETRIES -eq 0 ]]; do
  sleep 1
  ((RETRIES--))
done

if [[ $RETRIES -eq 0 ]]; then
  err "PostgreSQL failed to start. Check: $COMPOSE logs postgres"
  exit 1
fi
ok "PostgreSQL is ready"

info "Starting Astrobot..."
$COMPOSE up -d astrobot
ok "Astrobot is running"

# ── Verify ─────────────────────────────────────────────────────────

header "Deployment complete"

echo ""
echo -e "${GREEN}${BOLD}Astrobot v2 is deployed!${NC}"
echo ""
echo "  Assistant name:      $ASSISTANT_NAME"
echo "  Orchestrator model:  $ORCHESTRATOR_MODEL"
echo "  Default agent model: $DEFAULT_AGENT_MODEL"
echo "  Embedding model:     $EMBEDDING_MODEL"
echo ""
echo "  1Password vault:     $VAULT_NAME"
echo "  Telegram token:      $TELEGRAM_REF"
echo "  OpenRouter key:      $OPENROUTER_REF"
echo "  Postgres password:   $POSTGRES_REF"
echo ""
echo "Commands:"
echo "  $COMPOSE logs -f astrobot     # View logs"
echo "  $COMPOSE restart astrobot     # Restart"
echo "  $COMPOSE down                 # Stop all"
echo "  ./scripts/update.sh           # Update to latest"
echo ""
echo "Open Telegram and message your bot to get started!"
