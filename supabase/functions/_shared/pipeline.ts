export function nextAnalysisChunk<T>(
  queue: T[],
  offset: number,
  requestedSize = 4,
) {
  const safeOffset = Math.max(0, Math.floor(offset));
  const size = Math.max(1, Math.min(4, Math.floor(requestedSize)));
  const items = queue.slice(safeOffset, safeOffset + size);
  const nextOffset = safeOffset + items.length;
  return { items, nextOffset, complete: nextOffset >= queue.length };
}
