-- ─────────────────────────────────────────────────────────────────────
-- Migration 002: Seed external MCP servers
--
-- Registers seven external MCP servers as global tools available to all
-- agents. Env values use ${VAR_NAME} syntax — resolved from the host's
-- process.env at container launch time (see container-runner.ts).
--
-- ON CONFLICT DO NOTHING: safe to re-run; won't overwrite user changes.
-- ─────────────────────────────────────────────────────────────────────

-- 1. Slack — workspace messaging, channel history, reactions
INSERT INTO mcp_servers (name, transport, command, args, url, env, scope)
VALUES (
  'slack',
  'stdio',
  'npx',
  '["-y", "@zencoderai/slack-mcp-server"]'::jsonb,
  NULL,
  '{
    "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
    "SLACK_TEAM_ID": "${SLACK_TEAM_ID}",
    "SLACK_CHANNEL_IDS": "${SLACK_CHANNEL_IDS}"
  }'::jsonb,
  'global'
) ON CONFLICT (name) DO NOTHING;

-- 2. Todoist — task management, projects, labels, comments
INSERT INTO mcp_servers (name, transport, command, args, url, env, scope)
VALUES (
  'todoist',
  'stdio',
  'npx',
  '["-y", "todoist-mcp"]'::jsonb,
  NULL,
  '{
    "API_KEY": "${TODOIST_API_KEY}"
  }'::jsonb,
  'global'
) ON CONFLICT (name) DO NOTHING;

-- 3. Playwright — headless browser automation (Chromium pre-installed)
INSERT INTO mcp_servers (name, transport, command, args, url, env, scope)
VALUES (
  'playwright',
  'stdio',
  'npx',
  '["-y", "@playwright/mcp", "--headless", "--browser", "chromium"]'::jsonb,
  NULL,
  '{
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium",
    "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1"
  }'::jsonb,
  'global'
) ON CONFLICT (name) DO NOTHING;

-- 4. Brave Search — web, local, image, video, news search + AI summaries
INSERT INTO mcp_servers (name, transport, command, args, url, env, scope)
VALUES (
  'brave_search',
  'stdio',
  'npx',
  '["-y", "@brave/brave-search-mcp-server"]'::jsonb,
  NULL,
  '{
    "BRAVE_API_KEY": "${BRAVE_API_KEY}"
  }'::jsonb,
  'global'
) ON CONFLICT (name) DO NOTHING;

-- 5. Google Workspace — Gmail, Calendar, Drive, Docs, Sheets, etc.
--    NOTE: Requires one-time OAuth flow. Credentials persist in /workspace/mcp-data/.
--    The sh -c wrapper ensures CWD is writable (workspace-mcp creates tmp/attachments).
INSERT INTO mcp_servers (name, transport, command, args, url, env, scope)
VALUES (
  'google_workspace',
  'stdio',
  'sh',
  '["-c", "cd /workspace/agent && exec uvx workspace-mcp"]'::jsonb,
  NULL,
  '{
    "GOOGLE_OAUTH_CLIENT_ID": "${GOOGLE_OAUTH_CLIENT_ID}",
    "GOOGLE_OAUTH_CLIENT_SECRET": "${GOOGLE_OAUTH_CLIENT_SECRET}",
    "OAUTHLIB_INSECURE_TRANSPORT": "1",
    "GOOGLE_MCP_CREDENTIALS_DIR": "/workspace/mcp-data/google-workspace",
    "UV_CACHE_DIR": "/opt/uv-cache"
  }'::jsonb,
  'global'
) ON CONFLICT (name) DO NOTHING;

-- 6. App Store Connect — manage apps, beta testers, versions, analytics, sales reports
--    The .p8 private key is stored in 1Password and passed as APP_STORE_CONNECT_P8_KEY.
--    A shell wrapper writes it to a temp file at launch (the MCP server expects a file path).
INSERT INTO mcp_servers (name, transport, command, args, url, env, scope)
VALUES (
  'app_store_connect',
  'stdio',
  'sh',
  '["-c", "printf ''%s'' \"$APP_STORE_CONNECT_P8_KEY\" > /tmp/asc-authkey.p8 && exec npx -y appstore-connect-mcp-server"]'::jsonb,
  NULL,
  '{
    "APP_STORE_CONNECT_KEY_ID": "${APP_STORE_CONNECT_KEY_ID}",
    "APP_STORE_CONNECT_ISSUER_ID": "${APP_STORE_CONNECT_ISSUER_ID}",
    "APP_STORE_CONNECT_P8_KEY": "${APP_STORE_CONNECT_P8_KEY}",
    "APP_STORE_CONNECT_P8_PATH": "/tmp/asc-authkey.p8",
    "APP_STORE_CONNECT_VENDOR_NUMBER": "${APP_STORE_CONNECT_VENDOR_NUMBER}"
  }'::jsonb,
  'global'
) ON CONFLICT (name) DO NOTHING;

-- 7. Financial Modeling Prep — financial analysis, stock quotes, market data
--    Pre-installed from git at /opt/fmp-mcp-server; runs via python3 -m src.server
INSERT INTO mcp_servers (name, transport, command, args, url, env, scope)
VALUES (
  'financial_modeling_prep',
  'stdio',
  'sh',
  '["-c", "cd /opt/fmp-mcp-server && exec python3 -m src.server"]'::jsonb,
  NULL,
  '{
    "FMP_API_KEY": "${FMP_API_KEY}"
  }'::jsonb,
  'global'
) ON CONFLICT (name) DO NOTHING;
