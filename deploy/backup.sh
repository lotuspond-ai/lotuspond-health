#!/bin/sh
# Back up the database and the (encrypted) uploaded files into deploy/backups/, keeping 14 days. Run nightly by
# lotuspond-backup.timer (deploy/install-backup.sh), or by hand.
#
# Off-server copy: with BACKUP_S3_URI and BACKUP_AGE_RECIPIENT set (in deploy/.env or the environment), this run's
# database dump, files archive and deploy/.env are each encrypted with age to that public key and uploaded to S3.
# The server holds only the public key: it can write backups but not read them. The private key stays offline, with
# the person who restores (deploy/aws-lightsail.md, "Off-server backups"). Nothing is uploaded unencrypted: the
# dump holds the records in the clear, and .env holds FILE_ENCRYPTION_KEY, which unlocks the files.
set -eu
cd "$(dirname "$0")"

# A setting from the environment, else from deploy/.env (plain KEY=value lines; quotes are not interpreted).
setting() {
  eval "v=\${$1:-}"
  if [ -z "$v" ] && [ -f .env ]; then v=$(sed -n "s/^$1=//p" .env | tail -n 1); fi
  v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
  printf '%s' "$v"
}
s3_uri=$(setting BACKUP_S3_URI)
recipient=$(setting BACKUP_AGE_RECIPIENT)
if [ -n "$s3_uri" ]; then
  case "$recipient" in
    age1*) ;;
    *) echo "BACKUP_S3_URI is set but BACKUP_AGE_RECIPIENT is not an age public key (age1...): not backing up off the server unencrypted." >&2; exit 1 ;;
  esac
  command -v age >/dev/null || { echo "age is not installed (sudo apt-get install -y age)." >&2; exit 1; }
fi

stamp=$(date -u +%Y%m%d-%H%M%S)
umask 077
mkdir -p backups
docker compose exec -T db pg_dump -U lotuspond -Fc lotuspond > "backups/db-$stamp.dump"
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backups" --entrypoint tar app czf "/backups/files-$stamp.tgz" -C /data .
find backups -maxdepth 1 -type f -mtime +14 -delete
echo "Backed up to deploy/backups/ (db-$stamp.dump, files-$stamp.tgz)."

if [ -n "$s3_uri" ]; then
  out=$(mktemp -d)
  trap 'rm -rf "$out"' EXIT
  age -r "$recipient" -o "$out/db-$stamp.dump.age" "backups/db-$stamp.dump"
  age -r "$recipient" -o "$out/files-$stamp.tgz.age" "backups/files-$stamp.tgz"
  age -r "$recipient" -o "$out/env-$stamp.age" .env
  # Upload only this run's files, one by one: the server's key may write new objects, never list, read or delete.
  for f in "$out"/*.age; do
    docker run --rm -v "$HOME/.aws:/root/.aws:ro" -v "$out:/out:ro" "${AWS_CLI_IMAGE:-amazon/aws-cli}" \
      s3 cp "/out/$(basename "$f")" "${s3_uri%/}/$(basename "$f")" --only-show-errors
  done
  echo "Encrypted copies uploaded to ${s3_uri%/}/ (db-$stamp.dump.age, files-$stamp.tgz.age, env-$stamp.age)."
fi
