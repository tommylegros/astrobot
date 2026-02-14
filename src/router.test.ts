import { describe, it, expect } from 'vitest';
import { escapeXml, formatUserMessage, stripInternalTags, formatOutbound } from './router.js';

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeXml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes quotes', () => {
    expect(escapeXml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });

  it('handles string with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });
});

describe('formatUserMessage', () => {
  it('formats a user message with XML tags', () => {
    const result = formatUserMessage('Alice', 'Hello there', '2026-01-01T00:00:00Z');
    expect(result).toContain('<message');
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('Hello there');
    expect(result).toContain('</message>');
  });

  it('escapes special characters in sender name', () => {
    const result = formatUserMessage('Bob & "Friends"', 'test', '2026-01-01T00:00:00Z');
    expect(result).toContain('Bob &amp; &quot;Friends&quot;');
  });

  it('escapes special characters in content', () => {
    const result = formatUserMessage('Alice', '<script>alert("xss")</script>', '2026-01-01T00:00:00Z');
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });
});

describe('stripInternalTags', () => {
  it('removes internal tags', () => {
    const text = 'Hello <internal>thinking...</internal> World';
    expect(stripInternalTags(text)).toBe('Hello  World');
  });

  it('removes multiple internal blocks', () => {
    const text = '<internal>a</internal>Hello<internal>b</internal>';
    expect(stripInternalTags(text)).toBe('Hello');
  });

  it('handles multiline internal content', () => {
    const text = 'Start<internal>\nline1\nline2\n</internal>End';
    expect(stripInternalTags(text)).toBe('StartEnd');
  });

  it('returns original text when no internal tags', () => {
    expect(stripInternalTags('Hello World')).toBe('Hello World');
  });

  it('handles empty string', () => {
    expect(stripInternalTags('')).toBe('');
  });
});

describe('formatOutbound', () => {
  it('strips internal tags from output', () => {
    const result = formatOutbound('Hello <internal>thinking</internal> World');
    expect(result).toBe('Hello  World');
  });

  it('returns empty string for internal-only content', () => {
    const result = formatOutbound('<internal>only internal</internal>');
    expect(result).toBe('');
  });

  it('passes through clean text', () => {
    expect(formatOutbound('Hello World')).toBe('Hello World');
  });
});
