#!/bin/sh
# Back up the database and the (encrypted) uploaded files into deploy/backups/, keeping 14 days.
# Run nightly from cron, then copy deploy/backups/ off the server. Back up deploy/.env separately:
# the files cannot be read without FILE_ENCRYPTION_KEY.
set -eu
cd "$(dirname "$0")"
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
docker compose exec -T db pg_dump -U lotuspond -Fc lotuspond > "backups/db-$stamp.dump"
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backups" --entrypoint tar app czf "/backups/files-$stamp.tgz" -C /data .
find backups -type f -mtime +14 -delete
echo "Backed up to deploy/backups/ (db-$stamp.dump, files-$stamp.tgz)."
