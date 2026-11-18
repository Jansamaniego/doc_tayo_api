#!/bin/sh
# Runs once when the compose Postgres container starts with an empty volume.
set -eu
psql -v ON_ERROR_STOP=1 \
  -v owner_password="$DB_OWNER_PASSWORD" \
  -v app_password="$DB_APP_PASSWORD" \
  --username "$POSTGRES_USER" --dbname postgres \
  -f /scripts/db/bootstrap.sql
