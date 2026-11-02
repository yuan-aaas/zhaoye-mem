export function createMutex() {
  let pending: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work);
    pending = result.catch(() => undefined);
    return result;
  };
}
