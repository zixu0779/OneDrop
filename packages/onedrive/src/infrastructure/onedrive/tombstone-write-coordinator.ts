let tombstoneWriteQueue: Promise<void> = Promise.resolve();

/**
 * Serializes writes to the shared monthly tombstone document without blocking
 * independent message-chunk writes such as sending text or files.
 */
export function enqueueTombstoneWrite<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const queued = tombstoneWriteQueue.catch(() => undefined).then(operation);
  tombstoneWriteQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}
