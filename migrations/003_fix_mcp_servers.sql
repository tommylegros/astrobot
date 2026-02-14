-- ─────────────────────────────────────────────────────────────────────
-- Migration 003: Fix MCP server configurations
--
-- 1. Playwright: Remove invalid --no-chromium-sandbox flag.
-- 2. App Store Connect: Add new MCP server (if not already present).
-- 3. Financial Modeling Prep: Add new MCP server (if not already present).
-- ─────────────────────────────────────────────────────────────────────

-- Fix Playwright args: remove the invalid --no-chromium-sandbox flag
UPDATE mcp_servers
SET args = '["-y", "@playwright/mcp", "--headless", "--browser", "chromium"]'::jsonb
WHERE name = 'playwright';

-- Fix Google Workspace: wrap in sh -c to ensure writable CWD
-- (workspace-mcp creates tmp/attachments relative to CWD at import time)
UPDATE mcp_servers
SET command = 'sh',
    args = '["-c", "cd /workspace/agent && exec uvx workspace-mcp"]'::jsonb
WHERE name = 'google_workspace';

-- Fix App Store Connect: base64-decode the .p8 key (multiline PEM breaks env vars)
UPDATE mcp_servers
SET args = '["-c", "printf ''%s'' \"$APP_STORE_CONNECT_P8_KEY\" | base64 -d > /tmp/asc-authkey.p8 && exec npx -y appstore-connect-mcp-server"]'::jsonb
WHERE name = 'app_store_connect';

-- Add App Store Connect MCP server if it doesn't exist yet
INSERT INTO mcp_servers (name, transport, command, args, url, env, scope)
VALUES (
  'app_store_connect',
  'stdio',
  'sh',
  '["-c", "printf ''%s'' \"$APP_STORE_CONNECT_P8_KEY\" | base64 -d > /tmp/asc-authkey.p8 && exec npx -y appstore-connect-mcp-server"]'::jsonb,
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

-- Add Financial Modeling Prep MCP server (idempotent — skips if already exists)
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
