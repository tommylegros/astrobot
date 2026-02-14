import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  SCHEDULER_POLL_INTERVAL,
  IPC_POLL_INTERVAL,
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  ORCHESTRATOR_TTL,
  DEFAULT_AGENT_TTL,
  IDLE_TIMEOUT,
  MAX_CONCURRENT_CONTAINERS,
  OPENROUTER_BASE_URL,
} from './config.js';

describe('config', () => {
  it('has default assistant name', () => {
    expect(ASSISTANT_NAME).toBeTruthy();
    expect(typeof ASSISTANT_NAME).toBe('string');
  });

  it('has valid polling intervals', () => {
    expect(POLL_INTERVAL).toBeGreaterThan(0);
    expect(SCHEDULER_POLL_INTERVAL).toBeGreaterThan(0);
    expect(IPC_POLL_INTERVAL).toBeGreaterThan(0);
  });

  it('has valid container config', () => {
    expect(CONTAINER_IMAGE).toBeTruthy();
    expect(CONTAINER_TIMEOUT).toBeGreaterThan(0);
    expect(ORCHESTRATOR_TTL).toBeGreaterThan(0);
    expect(DEFAULT_AGENT_TTL).toBeGreaterThan(0);
    expect(IDLE_TIMEOUT).toBeGreaterThan(0);
    expect(MAX_CONCURRENT_CONTAINERS).toBeGreaterThanOrEqual(1);
  });

  it('orchestrator TTL is longer than default agent TTL', () => {
    expect(ORCHESTRATOR_TTL).toBeGreaterThan(DEFAULT_AGENT_TTL);
  });

  it('has OpenRouter base URL', () => {
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });
});
