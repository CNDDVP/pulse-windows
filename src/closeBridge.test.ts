import { afterEach, expect, it, vi } from 'vitest';
import { connectCloseBridge, type CloseRequest } from './closeBridge';

afterEach(() => { vi.useRealTimers(); });

it('waits for subscription, recovers a dropped event and deduplicates delivery', async () => {
  vi.useFakeTimers();
  let listener!: (r: CloseRequest) => void;
  let registered!: (stop: () => void) => void;
  const request = { request_id: 7, source: 'native_x' };
  const ready = vi.fn(async () => {}), handle = vi.fn(async () => {}), unlisten = vi.fn();
  const stop = connectCloseBridge({
    listen: handler => { listener = handler; return new Promise(resolve => { registered = resolve; }); },
    ready, pending: async () => request, handle, error: vi.fn(),
  });
  expect(ready).not.toHaveBeenCalled();
  registered(unlisten);
  await vi.advanceTimersByTimeAsync(500);
  expect(ready).toHaveBeenCalledOnce();
  expect(handle).toHaveBeenCalledExactlyOnceWith(request);
  listener(request);
  await vi.advanceTimersByTimeAsync(1000);
  expect(handle).toHaveBeenCalledOnce();
  stop();
  expect(unlisten).toHaveBeenCalledOnce();
});

it('recovers even when event registration fails', async () => {
  vi.useFakeTimers();
  const handle = vi.fn(async () => {}), error = vi.fn();
  const stop = connectCloseBridge({ listen: async () => { throw Error('channel unavailable'); },
    ready: async () => {}, pending: async () => ({ request_id: 1, source: 'button' }), handle, error });
  await vi.advanceTimersByTimeAsync(500);
  expect(handle).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
  stop();
});

it('cleans up a subscription resolving after unmount without announcing ready', async () => {
  vi.useFakeTimers();
  let registered!: (stop: () => void) => void;
  const unlisten = vi.fn(), ready = vi.fn(async () => {});
  const stop = connectCloseBridge({ listen: () => new Promise(resolve => { registered = resolve; }),
    ready, pending: async () => null, handle: async () => {}, error: vi.fn() });
  stop(); registered(unlisten);
  await vi.advanceTimersByTimeAsync(1000);
  expect(ready).not.toHaveBeenCalled();
  expect(unlisten).toHaveBeenCalledOnce();
});
