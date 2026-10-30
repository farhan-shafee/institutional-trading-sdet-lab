import type pg from 'pg';
/** Pool error listeners cover idle clients, not clients checked out by a transaction. */
export function observeLeasedClient(client: pg.PoolClient) {
  let failure: Error | undefined;
  const onError = (error: Error) => {
    failure = error;
  };
  client.on('error', onError);
  return {
    check() {
      if (failure) throw failure;
    },
    release(destroy = false) {
      if (destroy) {
        client.once('end', () => client.removeListener('error', onError));
        client.release(true);
      } else {
        // release installs the pool's idle listener synchronously; avoid an unobserved gap.
        client.release();
        client.removeListener('error', onError);
      }
    },
  };
}
