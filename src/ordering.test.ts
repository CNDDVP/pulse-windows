import { describe, it, expect } from 'vitest';
import { orderedIds, moveItem, applyOrder } from './ordering';
import type { ProviderConfig } from './types';

const cfg = (order: number): ProviderConfig => ({
  provider_id: 'codex', label: 'x', enabled: true, order, use_local: false,
  credential_configured: false, primary_window: null, elapsed_window: null
});

describe('rail ordering', () => {
  it('sorts by order and breaks ties by id', () => {
    const providers = { b: cfg(1), a: cfg(1), c: cfg(0) };
    expect(orderedIds(providers)).toEqual(['c', 'a', 'b']);
  });
  it('moves an item up and is a no-op at the edges', () => {
    const a = ['antigravity', 'codex', 'kimi', 'claude'];
    expect(moveItem(a, 1, 0)).toEqual(['codex', 'antigravity', 'kimi', 'claude']);
    expect(moveItem(a, 2, 3)).toEqual(['antigravity', 'codex', 'claude', 'kimi']);
    expect(moveItem(a, 0, 0)).toBe(a);
    expect(moveItem(a, -1, 2)).toBe(a);
  });
  it('renumbers after a drag and keeps unlisted accounts behind', () => {
    const providers = { a: cfg(0), b: cfg(1), c: cfg(2), d: cfg(3) };
    const next = applyOrder(providers, ['c', 'b']);
    expect(orderedIds(next)).toEqual(['c', 'b', 'a', 'd']);
    expect(orderedIds(next).map(id => next[id].order)).toEqual([0, 1, 2, 3]);
    expect(applyOrder(providers, ['ghost'])).toEqual(providers); // unknown ids are ignored
  });
});
