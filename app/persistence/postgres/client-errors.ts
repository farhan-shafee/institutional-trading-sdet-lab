import type pg from 'pg';

export type ClientLease = {
  client: pg.PoolClient;
  readonly error: Error | undefined;
  release: (destroy?: boolean) => void;
};

/** Own connection-level events for exactly the checked-out lifetime. */
export function checkoutClient(pool: pg.Pool): Promise<ClientLease> {
  return new Promise((resolve, reject) => {
    // pg-pool removes its idle listener before this callback. Install ownership
    // synchronously, before protocol parsing or the await continuation resumes.
    pool.connect((error, client) => {
      if (error) return reject(error);
      if (!client) return reject(new Error('PostgreSQL checkout returned no client.'));
      let failure: Error | undefined,
        released = false,
        ended = false;
      const onError = (cause: Error) => {
        if (!released) failure ??= cause;
      };
      const stop = () => {
        client.removeListener('error', onError);
        client.removeListener('end', onEnd);
      };
      const onEnd = () => {
        ended = true;
        if (!released) failure ??= new Error('PostgreSQL connection ended.');
        stop();
      };
      client.on('error', onError);
      client.once('end', onEnd);
      resolve({
        client,
        get error() {
          return failure;
        },
        release(destroy = false) {
          if (released) return;
          released = true;
          if (destroy || failure || ended) {
            // Destruction removes pool ownership. Keep ours through any queued
            // FATAL delivery until end; an already-ended client needs no wait.
            try {
              client.release(true);
            } finally {
              if (ended) stop();
            }
          } else {
            // Healthy release restores pool ownership before ours is removed.
            try {
              client.release();
            } finally {
              stop();
            }
          }
        },
      });
    });
  });
}
