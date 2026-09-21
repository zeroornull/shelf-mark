import { reactive, ref, toRaw } from 'vue';
import { describe, expect, it } from 'vitest';
import { toPlain } from '../src/lib/plain';

describe('toPlain', () => {
  it('turns a Proxy with a function and Error into a structuredClone-able plain object', () => {
    const proxied = new Proxy(
      { keep: 1, nested: { ok: true }, fn: () => 1, err: new Error('boom') },
      {},
    );

    expect(() => structuredClone(proxied)).toThrow(/could not be cloned/);

    const plain = toPlain(proxied);
    expect(plain).toEqual({ keep: 1, nested: { ok: true }, err: 'boom' });
    expect(plain.fn).toBeUndefined();
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(() => structuredClone(plain)).not.toThrow();
  });

  it('plain-clones a Vue-reactive job that holds settings.seedCategories', () => {
    const settings = reactive({
      seedCategories: ['前端', '生活'],
      userHint: '合并购物',
      includeFoldered: true,
    });
    const seeds = ref([...settings.seedCategories]);
    const job = {
      id: 'job-1',
      phase: 'loading-tree',
      total: 0,
      done: 0,
      skipped: [],
      input: {
        seedCategories: seeds.value,
        userHint: settings.userHint,
        includeFoldered: settings.includeFoldered,
      },
    };

    expect(() => structuredClone(job)).toThrow(/could not be cloned/);
    expect(() => structuredClone(toRaw(job))).toThrow(/could not be cloned/);

    const plain = toPlain(job);
    expect(plain.input.seedCategories).toEqual(['前端', '生活']);
    expect(Array.isArray(plain.input.seedCategories)).toBe(true);
    expect(() => structuredClone(plain)).not.toThrow();
  });
});
