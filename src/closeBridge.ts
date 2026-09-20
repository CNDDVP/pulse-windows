export interface CloseRequest { request_id: number; source: string }

/** Subscribe before announcing readiness; IPC recovers a dropped native event. */
export function connectCloseBridge(deps: {
  listen: (handler: (request: CloseRequest) => void) => Promise<() => void>;
  ready: () => Promise<unknown>;
  pending: () => Promise<CloseRequest | null>;
  handle: (request: CloseRequest) => Promise<void>;
  error: (error: unknown) => void;
}) {
  let alive = true, polling = false;
  let stop: (() => void) | undefined;
  const handled = new Set<number>();
  const deliver = (request: CloseRequest) => {
    if (!alive || handled.has(request.request_id)) return;
    handled.add(request.request_id);
    if (handled.size > 64) handled.delete(handled.values().next().value!);
    void deps.handle(request).catch(error => {
      handled.delete(request.request_id);
      if (alive) deps.error(error);
    });
  };
  const poll = async () => {
    if (!alive || polling) return;
    polling = true;
    try { const request = await deps.pending(); if (request) deliver(request); }
    catch (error) { if (alive) deps.error(error); }
    finally { polling = false; }
  };
  void (async () => {
    try { stop = await deps.listen(deliver); }
    catch (error) { if (alive) deps.error(error); }
    if (!alive) { stop?.(); return; }
    // Even if event registration failed, the IPC polling receiver is available.
    try { await deps.ready(); await poll(); }
    catch (error) { if (alive) deps.error(error); }
  })();
  const timer = setInterval(() => { void poll(); }, 500);
  return () => { alive = false; clearInterval(timer); stop?.(); };
}
