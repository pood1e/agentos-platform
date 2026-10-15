#!/bin/sh
set -eu
postgres_root=$(mktemp -d /tmp/agentos-pg.XXXXXX)
cleanup() {
  pg_ctl -D "$postgres_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$postgres_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
initdb -D "$postgres_root/data" --username=postgres --auth-local=trust --auth-host=reject \
  --encoding=UTF8 --no-locale --no-sync >/dev/null
pg_ctl -D "$postgres_root/data" -l "$postgres_root/server.log" \
  -o "-F -k $postgres_root -c listen_addresses='' -c unix_socket_permissions=0700" -w start >/dev/null
export PGHOST="$postgres_root"
export PGUSER=postgres
export CHANGE_TEST_DATABASE_URL='postgresql:///postgres?sslmode=disable'
export KAGENT_TEST_POSTGRES_URL="$CHANGE_TEST_DATABASE_URL"
export SUBSTRATE_TEST_POSTGRES_URL="$CHANGE_TEST_DATABASE_URL"
psql "$CHANGE_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION vector' >/dev/null
"$@"
