import type { Pool } from 'pg';

const ignoreLateError = (): void => undefined;

/**
 * Ends a pg pool and returns once every client socket has closed (MP-K47).
 *
 * pg-pool resolves end() as soon as no client is listed, while each removed client
 * is still closing its socket. A server error in that window, such as an
 * administrator terminating the backend, is emitted on the pool, and a pool without
 * an 'error' listener throws it as an uncaught exception. The no-op listener stays
 * on the ended pool; nothing else references that pool afterwards.
 */
export async function endPool(pool: Pool, timeoutMs = 5_000): Promise<void> {
  pool.on('error', ignoreLateError);
  const clients = pool.totalCount;
  let removed = 0;
  let onRemove: (() => void) | undefined;
  const allRemoved = new Promise<void>((resolve) => {
    if (clients === 0) {
      resolve();
      return;
    }
    onRemove = () => {
      removed += 1;
      if (removed >= clients) resolve();
    };
    pool.on('remove', onRemove);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await pool.end();
    await Promise.race([allRemoved, capped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onRemove) pool.off('remove', onRemove);
  }
}
