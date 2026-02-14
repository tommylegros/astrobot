import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the pure logic parts of credentials.ts
// The 1Password CLI calls are mocked

describe('credentials', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolveSecret returns env var when set', async () => {
    process.env.TEST_SECRET = 'from-env';
    const { resolveSecret } = await import('./credentials.js');
    const result = await resolveSecret('TEST_SECRET');
    expect(result).toBe('from-env');
    delete process.env.TEST_SECRET;
  });

  it('resolveSecret returns default when env var and op ref missing', async () => {
    delete process.env.NONEXISTENT_VAR;
    const { resolveSecret } = await import('./credentials.js');
    const result = await resolveSecret('NONEXISTENT_VAR', undefined, 'default-value');
    expect(result).toBe('default-value');
  });

  it('resolveSecret throws when no value available', async () => {
    delete process.env.NONEXISTENT_VAR;
    const { resolveSecret } = await import('./credentials.js');
    await expect(resolveSecret('NONEXISTENT_VAR')).rejects.toThrow('Missing required secret');
  });

  it('getSecret returns non-op:// strings as-is', async () => {
    const { getSecret } = await import('./credentials.js');
    const result = await getSecret('plain-api-key-123');
    expect(result).toBe('plain-api-key-123');
  });

  it('clearSecretCache clears the cache', async () => {
    const { clearSecretCache, getSecret } = await import('./credentials.js');
    // Should not throw for non-op:// references
    await getSecret('test-value');
    clearSecretCache();
    // After clearing, should still work for non-op:// references
    const result = await getSecret('test-value');
    expect(result).toBe('test-value');
  });
});
