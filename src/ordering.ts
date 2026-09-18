import type {ProviderConfig} from "./types";

/** Account ids in rail order: by `order`, ties broken by id so the result is stable. */
export function orderedIds(providers: Record<string, ProviderConfig>): string[] {
  return Object.entries(providers)
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

/** Move the item at `from` so it lands at `to`; returns a new array. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Renumber every account 0..n-1 following `ids` (drag result); accounts not in the
 *  list keep their relative order after them, and unknown ids are ignored. */
export function applyOrder(
  providers: Record<string, ProviderConfig>,
  ids: string[]
): Record<string, ProviderConfig> {
  const rest = orderedIds(providers).filter(id => !ids.includes(id));
  const seq = [...ids.filter(id => id in providers), ...rest];
  const next: Record<string, ProviderConfig> = { ...providers };
  seq.forEach((id, i) => { next[id] = { ...next[id], order: i }; });
  return next;
}
