# Astrobot Agent Container v2
# Runs OpenRouter-powered agent with MCP tool support

FROM node:22-slim

# Install system dependencies
#   - Chromium: for Playwright MCP browser automation
#   - Python 3 + venv: for Google Workspace MCP (Python-based)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for Playwright MCP browser automation
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ── Pre-install MCP server packages ─────────────────────────────────
# These are installed at build time so agent containers don't need to
# download them on every startup. npx finds global installs in PATH.

# Node.js MCP servers (installed globally → binaries in /usr/local/bin/)
RUN npm install -g \
    @zencoderai/slack-mcp-server \
    todoist-mcp \
    @playwright/mcp \
    @brave/brave-search-mcp-server \
    appstore-connect-mcp-server && \
    npm cache clean --force

# Python MCP servers: install uv/uvx system-wide
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    cp /root/.local/bin/uv /usr/local/bin/ && \
    cp /root/.local/bin/uvx /usr/local/bin/ && \
    rm -rf /root/.local

# Pre-cache Google Workspace MCP so uvx doesn't download at runtime
ENV UV_CACHE_DIR=/opt/uv-cache
RUN uvx workspace-mcp --help 2>/dev/null || true && \
    chmod -R a+rwX /opt/uv-cache

# Financial Modeling Prep MCP server (Python, git-based — not on PyPI)
# Clone + install deps at build time so it's ready to run as `python3 -m src.server`
RUN git clone --depth 1 https://github.com/cdtait/fmp-mcp-server.git /opt/fmp-mcp-server && \
    cd /opt/fmp-mcp-server && \
    uv pip install --system --break-system-packages -r requirements.txt && \
    chmod -R a+rX /opt/fmp-mcp-server

# ── Agent runner build ──────────────────────────────────────────────

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories (includes mcp-data for persistent credentials)
RUN mkdir -p /workspace/agent /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /workspace/mcp-data

# Create entrypoint script
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Entrypoint: compile TS in /app, then run from /workspace/agent so MCP child
# processes inherit a writable CWD (the node user owns /workspace but not /app).
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\ncd /workspace/agent && node /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root)
RUN chown -R node:node /workspace

# Switch to non-root user
USER node

# Set working directory to agent workspace
WORKDIR /workspace/agent

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
