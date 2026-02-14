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
ask()   { echo -en "${BOLD}$*${NC} "; }

TOTAL_STEPS=10
CURRENT_STEP=0
SCRIPT_START_TS="$(date +%s)"
APT_UPDATED=0

format_duration() {
  local total_seconds="${1:-0}"
  local hours=$(( total_seconds / 3600 ))
  local minutes=$(( (total_seconds % 3600) / 60 ))
  local seconds=$(( total_seconds % 60 ))

  if [[ "$hours" -gt 0 ]]; then
    printf "%dh %dm %ds" "$hours" "$minutes" "$seconds"
  elif [[ "$minutes" -gt 0 ]]; then
    printf "%dm %ds" "$minutes" "$seconds"
  else
    printf "%ds" "$seconds"
  fi
}

header() {
  CURRENT_STEP=$(( CURRENT_STEP + 1 ))
  local title="$1"
  local percent=$(( CURRENT_STEP * 100 / TOTAL_STEPS ))
  local bar_width=30
  local bar_filled=$(( percent * bar_width / 100 ))
  local now
  now="$(date +%s)"
  local elapsed
  elapsed="$(format_duration $(( now - SCRIPT_START_TS )))"
  local bar_fill bar_empty

  printf -v bar_fill '%*s' "$bar_filled" ''
  bar_fill="${bar_fill// /#}"
  printf -v bar_empty '%*s' "$(( bar_width - bar_filled ))" ''
  bar_empty="${bar_empty// /-}"

  echo ""
  echo -e "${BOLD}${CYAN}Step ${CURRENT_STEP}/${TOTAL_STEPS}: ${title}${NC}"
  echo -e "${CYAN}Progress: [${bar_fill}${bar_empty}] ${percent}%${NC}"
  echo -e "${BLUE}Elapsed: ${elapsed}${NC}"
  echo ""
}

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

has_cmd() {
  command -v "$1" &>/dev/null
}

ensure_brew_in_path() {
  if [[ -d /opt/homebrew/bin ]]; then
    export PATH="/opt/homebrew/bin:$PATH"
  fi
  if [[ -d /usr/local/bin ]]; then
    export PATH="/usr/local/bin:$PATH"
  fi
}

install_homebrew_if_needed() {
  ensure_brew_in_path
  if has_cmd brew; then
    return
  fi

  warn "Homebrew is not installed. Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ensure_brew_in_path

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  require_cmd brew "Homebrew installation failed. Install manually: https://brew.sh/"
  ok "Homebrew installed"
}

ensure_macos_dependency() {
  local cmd_name="$1"
  local brew_target="$2"
  local install_label="$3"

  if has_cmd "$cmd_name"; then
    return
  fi

  install_homebrew_if_needed
  info "Installing $install_label..."
  brew install "$brew_target"
  ok "$install_label installed"
}

ensure_docker_desktop_running() {
  local platform
  platform="$(uname -s)"

  if docker info &>/dev/null; then
    return
  fi

  if [[ "$platform" == "Darwin" ]]; then
    warn "Docker Desktop is installed but not running."
    info "Launching Docker Desktop..."
    open -a Docker || true
  elif [[ "$platform" == "Linux" ]]; then
    warn "Docker daemon is installed but not running."
    if has_cmd systemctl; then
      info "Starting docker service with systemd..."
      run_with_privilege systemctl enable --now docker
    else
      err "Docker daemon is not running and systemctl is unavailable."
      info "Start Docker manually, then re-run this script."
      exit 1
    fi
  fi

  local retries=60
  until docker info &>/dev/null || [[ $retries -eq 0 ]]; do
    sleep 2
    ((retries--))
  done

  if [[ $retries -eq 0 ]]; then
    err "Docker daemon is not ready. Start Docker, then re-run this script."
    exit 1
  fi
}

run_with_privilege() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
    return
  fi

  if has_cmd sudo; then
    sudo "$@"
    return
  fi

  err "This action needs root privileges, but sudo is not available."
  exit 1
}

ensure_apt_updated() {
  if [[ "$APT_UPDATED" -eq 1 ]]; then
    return
  fi

  info "Updating apt package index..."
  run_with_privilege apt-get update
  APT_UPDATED=1
}

ensure_linux_supported() {
  if [[ ! -f /etc/os-release ]]; then
    err "Cannot detect Linux distribution (missing /etc/os-release)."
    return 1
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  local family="${ID_LIKE:-}"
  if [[ "${ID:-}" =~ ^(ubuntu|debian)$ ]] || [[ "$family" == *debian* ]]; then
    return 0
  fi

  warn "Linux distro '${ID:-unknown}' is not auto-supported yet."
  return 1
}

install_linux_docker() {
  if has_cmd docker; then
    ok "Docker already installed"
    return
  fi

  ensure_linux_supported || return
  ensure_apt_updated
  info "Installing Docker engine + compose plugin for Debian/Ubuntu..."

  run_with_privilege apt-get install -y ca-certificates curl gnupg
  run_with_privilege install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "${ID}")/gpg" \
    | run_with_privilege gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  run_with_privilege chmod a+r /etc/apt/keyrings/docker.gpg

  local arch codename
  arch="$(dpkg --print-architecture)"
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}")"
  if [[ -z "$codename" ]]; then
    err "Unable to detect Linux codename for Docker repository setup."
    exit 1
  fi

  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "${ID}") ${codename} stable" \
    | run_with_privilege tee /etc/apt/sources.list.d/docker.list >/dev/null

  APT_UPDATED=0
  ensure_apt_updated
  run_with_privilege apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if has_cmd systemctl; then
    run_with_privilege systemctl enable --now docker
  fi
  ok "Docker installed"
}

install_linux_node() {
  local needs_node=1
  if has_cmd node; then
    local major
    major="$(node -v | sed 's/v//' | cut -d. -f1)"
    if [[ "$major" -ge 20 ]]; then
      needs_node=0
      ok "Node.js already installed: $(node -v)"
    fi
  fi

  if [[ "$needs_node" -eq 0 ]]; then
    return
  fi

  ensure_linux_supported || return
  ensure_apt_updated
  info "Installing Node.js 20 LTS..."

  run_with_privilege apt-get install -y ca-certificates curl gnupg
  run_with_privilege install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | run_with_privilege gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  run_with_privilege chmod a+r /etc/apt/keyrings/nodesource.gpg

  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    | run_with_privilege tee /etc/apt/sources.list.d/nodesource.list >/dev/null

  APT_UPDATED=0
  ensure_apt_updated
  run_with_privilege apt-get install -y nodejs
  ok "Node.js installed: $(node -v)"
}

install_linux_op() {
  if has_cmd op; then
    ok "1Password CLI already installed: $(op --version)"
    return
  fi

  ensure_linux_supported || return
  ensure_apt_updated
  info "Installing 1Password CLI..."

  run_with_privilege apt-get install -y ca-certificates curl gnupg
  run_with_privilege install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
    | run_with_privilege gpg --dearmor -o /usr/share/keyrings/1password-archive-keyring.gpg
  run_with_privilege chmod a+r /usr/share/keyrings/1password-archive-keyring.gpg

  local arch
  arch="$(dpkg --print-architecture)"
  echo "deb [arch=${arch} signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/${arch} stable main" \
    | run_with_privilege tee /etc/apt/sources.list.d/1password.list >/dev/null

  APT_UPDATED=0
  ensure_apt_updated
  run_with_privilege apt-get install -y 1password-cli
  ok "1Password CLI installed: $(op --version)"
}

install_linux_prerequisites() {
  if ! ensure_linux_supported; then
    info "Install prerequisites manually:"
    echo "  Docker: https://docs.docker.com/engine/install/"
    echo "  Node.js 20+: https://nodejs.org/"
    echo "  1Password CLI: https://developer.1password.com/docs/cli/get-started/"
    return
  fi

  install_linux_docker
  install_linux_node
  install_linux_op
}

install_prerequisites() {
  local platform
  platform="$(uname -s)"

  case "$platform" in
    Darwin)
      ensure_brew_in_path

      if ! has_cmd docker; then
        install_homebrew_if_needed
        info "Installing Docker Desktop..."
        brew install --cask docker
        ok "Docker Desktop installed"
      fi

      ensure_macos_dependency node node "Node.js"
      ensure_macos_dependency op 1password-cli "1Password CLI"
      ;;
    Linux)
      install_linux_prerequisites
      ;;
    *)
      warn "Automatic prerequisite installation is currently supported on macOS and Debian/Ubuntu Linux."
      info "Install prerequisites manually:"
      echo "  Docker: https://docs.docker.com/engine/install/"
      echo "  Node.js 20+: https://nodejs.org/"
      echo "  1Password CLI: https://developer.1password.com/docs/cli/get-started/"
      ;;
  esac
}

run_with_timer() {
  local label="$1"
  shift
  local start_ts end_ts
  start_ts="$(date +%s)"
  info "$label..."
  "$@"
  end_ts="$(date +%s)"
  ok "$label completed in $(format_duration $(( end_ts - start_ts )))"
}

ensure_op_authenticated() {
  if op whoami &>/dev/null 2>&1; then
    return 0
  fi

  warn "1Password CLI is not authenticated in this shell."
  info "This can happen on headless SSH sessions."

  local attempts=0
  while ! op whoami &>/dev/null 2>&1; do
    attempts=$(( attempts + 1 ))
    if [[ "$attempts" -gt 5 ]]; then
      err "Unable to authenticate 1Password CLI after multiple attempts."
      return 1
    fi

    echo ""
    echo "Choose a 1Password authentication method:"
    echo "  1) Interactive sign-in now (op signin)"
    echo "  2) Paste OP_SERVICE_ACCOUNT_TOKEN (recommended for headless servers)"
    echo "  3) Re-check authentication (if you signed in in another shell)"
    echo "  4) Abort deploy"
    echo ""
    ask "Auth method [1]:"
    local auth_choice
    read -r auth_choice

    case "${auth_choice:-1}" in
      1)
        info "Starting interactive sign-in..."
        info "If a device code is shown, complete it from any browser and return here."
        # op signin prints shell exports; eval applies them to this shell session.
        if eval "$(op signin)"; then
          ok "Interactive sign-in command completed"
        else
          warn "Interactive sign-in did not complete successfully."
        fi
        ;;
      2)
        ask "OP_SERVICE_ACCOUNT_TOKEN:"
        local service_token
        read -rs service_token
        echo ""
        if [[ -z "$service_token" ]]; then
          warn "No token entered."
        else
          export OP_SERVICE_ACCOUNT_TOKEN="$service_token"
          ok "Service account token exported for this session"
        fi
        ;;
      3)
        info "Re-checking 1Password authentication..."
        ;;
      4)
        err "Aborted by user."
        return 1
        ;;
      *)
        warn "Invalid option: ${auth_choice}"
        ;;
    esac
  done

  return 0
}

get_op_identity_label() {
  local whoami_json
  whoami_json="$(op whoami --format=json 2>/dev/null || true)"

  local email name service_id
  email="$(printf "%s" "$whoami_json" | grep -o '"email":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  name="$(printf "%s" "$whoami_json" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  service_id="$(printf "%s" "$whoami_json" | grep -o '"user_uuid":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"

  if [[ -n "$email" ]]; then
    printf "%s" "$email"
  elif [[ -n "$name" ]]; then
    printf "%s" "$name"
  elif [[ -n "$service_id" ]]; then
    printf "service-account:%s" "$service_id"
  else
    printf "authenticated session"
  fi
}

configure_vault() {
  local default_vault="Astrobot"
  local selected_vault
  local attempts=0

  while true; do
    attempts=$(( attempts + 1 ))
    if [[ "$attempts" -gt 8 ]]; then
      err "Unable to configure a usable 1Password vault after multiple attempts."
      exit 1
    fi

    ask "Vault name to use [${default_vault}]:"
    read -r selected_vault
    selected_vault="${selected_vault:-$default_vault}"

    if op vault get "$selected_vault" &>/dev/null 2>&1; then
      VAULT_NAME="$selected_vault"
      ok "Using vault '$VAULT_NAME'"
      return 0
    fi

    warn "Vault '$selected_vault' was not found or is not accessible with current credentials."

    local vault_names
    vault_names="$(op vault list --format=json 2>/dev/null | grep -o '"name":"[^"]*"' | cut -d'"' -f4 || true)"
    if [[ -n "$vault_names" ]]; then
      info "Accessible vaults for this account:"
      while IFS= read -r vault; do
        [[ -n "$vault" ]] && echo "  - $vault"
      done <<< "$vault_names"
    else
      info "Could not list vaults (permission-limited service account is common)."
    fi

    if confirm "Create vault '$selected_vault' if it does not exist?"; then
      info "Creating vault '$selected_vault'..."
      if op vault create "$selected_vault" --description "Astrobot AI assistant credentials" >/dev/null 2>&1; then
        VAULT_NAME="$selected_vault"
        ok "Vault '$VAULT_NAME' created and selected"
        return 0
      fi
      warn "Vault creation failed (likely insufficient permission)."
    fi

    info "Please choose an existing vault with read/write access."
    default_vault="$selected_vault"
  done
}

create_1password_item() {
  local vault="$1"
  local title="$2"
  local category_hint="$3"
  shift 3

  local -a category_candidates=()
  case "$category_hint" in
    api-credential|API\ Credential)
      category_candidates=("API Credential" "api-credential")
      ;;
    database|Database)
      category_candidates=("Database" "database")
      ;;
    *)
      category_candidates=("$category_hint")
      ;;
  esac

  local category
  for category in "${category_candidates[@]}"; do
    if op item create \
      --category="$category" \
      --vault="$vault" \
      --title="$title" \
      "$@" >/dev/null; then
      return 0
    fi
    warn "Item create failed with category '$category' for '$title'; trying next compatible category..."
  done

  err "Failed to create 1Password item '$title' in vault '$vault'. Check vault permissions."
  return 1
}

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

# ── Pre-flight checks ──────────────────────────────────────────────

header "Pre-flight checks"

info "Running deployment from: $PROJECT_DIR"
info "Script start time: $(date +"%Y-%m-%d %H:%M:%S")"

if confirm "Automatically install missing prerequisites (Docker, Node.js, 1Password CLI)?"; then
  install_prerequisites
fi

require_cmd docker "Install Docker: https://docs.docker.com/engine/install/"
ensure_docker_desktop_running
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
if ! ensure_op_authenticated; then
  info "1Password authentication is required for deployment."
  exit 1
fi
OP_ACCOUNT="$(get_op_identity_label)"
ok "1Password signed in as: $OP_ACCOUNT"

# ── 1Password vault setup ──────────────────────────────────────────

header "1Password vault setup"

configure_vault

# ── Collect credentials ────────────────────────────────────────────

header "Credential setup"
info "Checking for existing credential items in vault '$VAULT_NAME'"

echo "All secrets will be stored in 1Password and referenced via op:// URIs."
echo "Your .env file will NEVER contain raw secrets."
echo ""

# -- Telegram Bot Token --
ITEM_NAME="Telegram Bot"
if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
  ok "1Password item '$ITEM_NAME' already exists"
  TELEGRAM_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "token" "credential" "password" "value")" || {
    err "Cannot find a readable secret field on '$ITEM_NAME' in vault '$VAULT_NAME'"
    exit 1
  }
  TELEGRAM_REF="op://$VAULT_NAME/$ITEM_NAME/$TELEGRAM_FIELD"
else
  echo "You need a Telegram bot token from @BotFather (https://t.me/BotFather)."
  ask "Telegram Bot Token:"
  read -rs TELEGRAM_TOKEN
  echo ""

  if [[ -z "$TELEGRAM_TOKEN" ]]; then
    err "Telegram bot token is required."
    exit 1
  fi

  create_1password_item \
    "$VAULT_NAME" \
    "$ITEM_NAME" \
    "API Credential" \
    "token=$TELEGRAM_TOKEN" || exit 1

  ok "Stored Telegram bot token in 1Password"
  TELEGRAM_REF="op://$VAULT_NAME/$ITEM_NAME/token"
fi

# -- OpenRouter API Key --
ITEM_NAME="OpenRouter"
if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
  ok "1Password item '$ITEM_NAME' already exists"
  OPENROUTER_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "api key" "api_key" "credential" "password" "value")" || {
    err "Cannot find a readable secret field on '$ITEM_NAME' in vault '$VAULT_NAME'"
    exit 1
  }
  OPENROUTER_REF="op://$VAULT_NAME/$ITEM_NAME/$OPENROUTER_FIELD"
else
  echo "You need an OpenRouter API key from https://openrouter.ai/keys"
  ask "OpenRouter API Key:"
  read -rs OPENROUTER_KEY
  echo ""

  if [[ -z "$OPENROUTER_KEY" ]]; then
    err "OpenRouter API key is required."
    exit 1
  fi

  create_1password_item \
    "$VAULT_NAME" \
    "$ITEM_NAME" \
    "API Credential" \
    "api key=$OPENROUTER_KEY" || exit 1

  ok "Stored OpenRouter API key in 1Password"
  OPENROUTER_REF="op://$VAULT_NAME/$ITEM_NAME/api key"
fi

# -- Postgres Password --
ITEM_NAME="PostgreSQL"
if op item get "$ITEM_NAME" --vault "$VAULT_NAME" &>/dev/null 2>&1; then
  ok "1Password item '$ITEM_NAME' already exists"
  POSTGRES_FIELD="$(find_op_field "$VAULT_NAME" "$ITEM_NAME" "password" "credential" "value")" || {
    err "Cannot find a readable secret field on '$ITEM_NAME' in vault '$VAULT_NAME'"
    exit 1
  }
  POSTGRES_REF="op://$VAULT_NAME/$ITEM_NAME/$POSTGRES_FIELD"
else
  info "Generating a secure PostgreSQL password..."
  PG_PASSWORD=$(op generate-password --length=32 --no-symbols 2>/dev/null || openssl rand -base64 24)

  create_1password_item \
    "$VAULT_NAME" \
    "$ITEM_NAME" \
    "Database" \
    "password=$PG_PASSWORD" \
    "username=astrobot" \
    "database=astrobot" \
    "hostname=postgres" \
    "port=5432" || exit 1

  ok "Stored PostgreSQL credentials in 1Password"
  POSTGRES_REF="op://$VAULT_NAME/$ITEM_NAME/password"
fi

# ── Bot customization ──────────────────────────────────────────────

header "Bot customization"
info "Collecting assistant and model configuration"

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
  BACKUP_NAME=".env.backup.$(date +%s)"
  warn ".env already exists — backing up to $BACKUP_NAME"
  cp .env "$BACKUP_NAME"
  chmod 600 "$BACKUP_NAME"
  ok "Existing .env backed up (permissions locked)"
fi

# Validate all 1Password references before writing .env
info "Validating 1Password references..."
REFS_VALID=true
for ref in "$TELEGRAM_REF" "$OPENROUTER_REF" "$POSTGRES_REF"; do
  if ! op read "$ref" &>/dev/null; then
    err "Cannot read 1Password reference: $ref"
    REFS_VALID=false
  fi
done
if [[ "$REFS_VALID" != true ]]; then
  err "1Password reference validation failed. Check vault permissions and item fields."
  exit 1
fi
ok "All 1Password references validated"

cat > .env << ENVEOF
# ─────────────────────────────────────────────────────────────────────
# Astrobot v2 — Generated by deploy.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# Secrets are stored as op:// references — NO plaintext secrets in this file.
# 1Password resolves them at runtime via: op run --env-file=.env -- <command>
#
# To rotate credentials: ./scripts/update.sh --reconfigure
# ─────────────────────────────────────────────────────────────────────

# ── 1Password Vault ─────────────────────────────────────────────────

OP_VAULT=$VAULT_NAME

# ── Secrets (resolved at runtime by 'op run') ───────────────────────

TELEGRAM_BOT_TOKEN=$TELEGRAM_REF
OPENROUTER_API_KEY=$OPENROUTER_REF
POSTGRES_PASSWORD=$POSTGRES_REF

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

# Lock down .env permissions
chmod 600 .env

ok ".env generated with op:// references (no plaintext secrets on disk)"

# Define compose wrapper that resolves op:// references at runtime
op_compose() {
  op run --env-file=.env --no-masking -- $COMPOSE "$@"
}

# Verify op_compose resolves secrets correctly
info "Verifying secret resolution via 'op run'..."
if ! op run --env-file=.env --no-masking -- printenv POSTGRES_PASSWORD &>/dev/null; then
  err "'op run' failed to resolve secrets from .env."
  info "Ensure 1Password is authenticated (OP_SERVICE_ACCOUNT_TOKEN or 'eval \$(op signin)')."
  exit 1
fi
ok "Secret resolution verified"

# ── Install dependencies ───────────────────────────────────────────

header "Installing dependencies"

run_with_timer "Installing Node.js dependencies with npm ci" npm ci

# ── Build agent container ──────────────────────────────────────────

header "Building agent container"

run_with_timer "Building agent container image" bash ./container/build.sh

# ── Build host service ─────────────────────────────────────────────

header "Building host service"

run_with_timer "Compiling host TypeScript service" npm run build

# ── Start services ─────────────────────────────────────────────────

header "Starting services"

run_with_timer "Starting PostgreSQL service" op_compose up -d --build postgres

# Wait for postgres to be healthy
info "Waiting for PostgreSQL to be ready..."
RETRIES=30
ATTEMPT=1
until op_compose exec -T postgres pg_isready -U astrobot &>/dev/null || [[ $RETRIES -eq 0 ]]; do
  if (( ATTEMPT % 5 == 0 )); then
    info "PostgreSQL is still starting... (${ATTEMPT}/30 checks)"
  fi
  sleep 1
  ((RETRIES--))
  ((ATTEMPT++))
done

if [[ $RETRIES -eq 0 ]]; then
  err "PostgreSQL failed to start. Check: op_compose logs postgres"
  exit 1
fi
ok "PostgreSQL is ready"

info "Starting Astrobot..."
run_with_timer "Starting Astrobot service" op_compose up -d --build astrobot
ok "Astrobot is running and accepting messages"

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
echo -e "${BOLD}NOTE:${NC} All secrets are op:// references resolved at runtime."
echo ""
echo "Manage services:"
echo "  ./scripts/update.sh                  # Pull, rebuild, restart"
echo "  ./scripts/update.sh --reconfigure    # Change models/credentials"
echo ""
echo "Manual compose commands (requires 'op run' wrapper):"
echo "  op run --env-file=.env -- $COMPOSE logs -f astrobot"
echo "  op run --env-file=.env -- $COMPOSE restart astrobot"
echo "  op run --env-file=.env -- $COMPOSE down"
echo ""
echo "Open Telegram and message your bot to get started!"
