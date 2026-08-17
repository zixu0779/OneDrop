let maintenanceQueue: Promise<void> = Promise.resolve();

/**
 * Serializes recycle-bin restoration and irreversible deleted-data cleanup.
 * Reads use the same queue so the UI never receives a half-cleaned snapshot.
 */
export function enqueueDeletedDataMaintenance<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const queued = maintenanceQueue.catch(() => undefined).then(operation);
  maintenanceQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}
