let monthWriteQueue: Promise<void> = Promise.resolve();

export function enqueueMonthWrite<T>(operation: () => Promise<T>): Promise<T> {
  const queued = monthWriteQueue.catch(() => undefined).then(operation);
  monthWriteQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}
