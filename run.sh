#!/usr/bin/env bash
# Applies the migrations to a scratch Postgres and runs the RLS tests.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres tests/sql/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=mnemora_rls_test
psql -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB" -c "create database $DB" postgres
export PGDATABASE=$DB
psql -v ON_ERROR_STOP=1 -q -f tests/sql/supabase_stub.sql
for f in supabase/migrations/*.sql; do echo "applying $f"; psql -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -v ON_ERROR_STOP=1 -q -c "grant select,insert,update,delete on all tables in schema public to authenticated; grant select on all tables in schema public to anon; grant select,insert,update,delete on storage.objects to authenticated; grant execute on all functions in schema public to authenticated;"
psql -f tests/sql/rls_test.sql 2>&1 | sed -n -E "s/^psql:[^ ]+ (NOTICE|ERROR):  /\1 /p" | grep -E "^(NOTICE (PASS|FAIL)|ERROR)" | sed "s/^NOTICE //" | tee /dev/stderr | awk "BEGIN{p=0;f=0} /^PASS/{p++} /^FAIL|^ERROR/{f++} END{print \"RESULT: \" p \" passed, \" f \" failed\"}"
