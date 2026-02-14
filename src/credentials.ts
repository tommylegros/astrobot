/**
 * 1Password CLI credential provider for Astrobot
 *
 * Wraps `op read` to fetch secrets at runtime.
 * Secrets are cached in memory for the process lifetime.
 *
 * References use 1Password URI format: op://vault/item/field
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { DATABASE_URL_REF } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const secretCache = new Map<string, string>();

/**
 * Read a secret from 1Password using the CLI.
 * Results are cached in memory.
 *
 * @param reference - 1Password URI (e.g., "op://astrobot/openrouter/api-key")
 *                    or a plain string (returned as-is, for env var fallback)
 */
export async function getSecret(reference: string): Promise<string> {
  // If it's not an op:// reference, return as-is (supports env var fallback)
  if (!reference.startsWith('op://')) {
    return reference;
  }

  const cached = secretCache.get(reference);
  if (cached) return cached;

  try {
    const { stdout } = await execFileAsync('op', ['read', reference], {
      timeout: 15000,
      env: { ...process.env },
    });
    const value = stdout.trim();
    if (!value) {
      throw new Error(`Empty value returned for ${reference}`);
    }
    secretCache.set(reference, value);
    logger.debug({ reference: reference.replace(/\/[^/]+$/, '/***') }, '1Password secret loaded');
    return value;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Check if op CLI is not installed
    if (msg.includes('ENOENT') || msg.includes('not found')) {
      throw new Error(
        '1Password CLI (op) is not installed. Install from: https://developer.1password.com/docs/cli/get-started/',
      );
    }
    // Check if not signed in
    if (msg.includes('not signed in') || msg.includes('sign in')) {
      throw new Error(
        '1Password CLI is not signed in. Run: eval $(op signin)',
      );
    }
    throw new Error(`Failed to read 1Password secret ${reference}: ${msg}`);
  }
}

/**
 * Resolve a config value that may be a 1Password reference or env var.
 * Priority: env var > 1Password reference > default
 */
export async function resolveSecret(
  envVar: string,
  opReference?: string,
  defaultValue?: string,
): Promise<string> {
  // Check env var first
  const envValue = process.env[envVar];
  if (envValue) {
    // If the env var itself is an op:// reference, resolve it
    if (envValue.startsWith('op://')) {
      return getSecret(envValue);
    }
    return envValue;
  }

  // Try 1Password reference
  if (opReference) {
    try {
      return await getSecret(opReference);
    } catch (err) {
      if (defaultValue !== undefined) {
        logger.warn(
          { envVar, error: err instanceof Error ? err.message : String(err) },
          'Failed to read from 1Password, using default',
        );
        return defaultValue;
      }
      throw err;
    }
  }

  if (defaultValue !== undefined) return defaultValue;
  throw new Error(
    `Missing required secret: set ${envVar} env var or configure 1Password reference`,
  );
}

/**
 * Build a secrets map for passing to a container agent.
 * Resolves all 1Password references to actual values.
 */
export async function getContainerSecrets(): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};

  // OpenRouter API key is always needed
  try {
    secrets.OPENROUTER_API_KEY = await resolveSecret(
      'OPENROUTER_API_KEY',
      process.env.OPENROUTER_API_KEY_REF,
    );
  } catch {
    logger.warn('OpenRouter API key not available');
  }

  // Database URL for memory MCP server
  // DATABASE_URL may not be in env directly — config.ts constructs it from
  // POSTGRES_PASSWORD when needed, so use the resolved config value.
  try {
    secrets.DATABASE_URL = await resolveSecret(
      'DATABASE_URL',
      process.env.DATABASE_URL_REF,
      DATABASE_URL_REF,
    );
  } catch {
    logger.warn('Database URL not available for container');
  }

  return secrets;
}

/** Clear the secret cache (useful for testing or credential rotation) */
export function clearSecretCache(): void {
  secretCache.clear();
}
