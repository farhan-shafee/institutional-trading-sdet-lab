FROM postgres:17.10-bookworm@sha256:9b18b78397054fce88a9552e9d5a3ad5bb7fd258c5b3cc1c5028e46373d6ea8f

ENV PGDATA=/var/lib/postgresql/data/pgdata
COPY deployment/postgres/entrypoint.sh /usr/local/bin/tradeflow-postgres
COPY deployment/postgres/init.sh /docker-entrypoint-initdb.d/10-tradeflow.sh
COPY db/migrations /opt/tradeflow/db/migrations
COPY db/public-demo /opt/tradeflow/db/public-demo
COPY deployment/postgres/SHA256SUMS /opt/tradeflow/SHA256SUMS
RUN command -v openssl && chmod 0755 /usr/local/bin/tradeflow-postgres /docker-entrypoint-initdb.d/10-tradeflow.sh

ENTRYPOINT ["/usr/local/bin/tradeflow-postgres"]
CMD ["postgres"]
