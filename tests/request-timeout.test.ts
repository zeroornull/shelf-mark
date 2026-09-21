import { describe, expect, it } from 'vitest';
import {
  clampRequestTimeoutMs,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
} from '../src/lib/request-timeout';

describe('clampRequestTimeoutMs', () => {
  it('defaults missing / non-finite values to 180s', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(clampRequestTimeoutMs(undefined)).toBe(180_000);
    expect(clampRequestTimeoutMs(Number.NaN)).toBe(180_000);
    expect(clampRequestTimeoutMs(Number.POSITIVE_INFINITY)).toBe(180_000);
  });

  it('clamps to 30s–10min', () => {
    expect(MIN_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(MAX_REQUEST_TIMEOUT_MS).toBe(600_000);
    expect(clampRequestTimeoutMs(1_000)).toBe(30_000);
    expect(clampRequestTimeoutMs(29_999)).toBe(30_000);
    expect(clampRequestTimeoutMs(30_000)).toBe(30_000);
    expect(clampRequestTimeoutMs(180_000)).toBe(180_000);
    expect(clampRequestTimeoutMs(600_000)).toBe(600_000);
    expect(clampRequestTimeoutMs(600_001)).toBe(600_000);
    expect(clampRequestTimeoutMs(1_000_000)).toBe(600_000);
  });
});
