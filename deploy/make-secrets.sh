#!/bin/sh
# Create deploy/.env from .env.example with fresh secrets. Runs once; it never overwrites an existing .env.
set -eu
cd "$(dirname "$0")"
if [ -f .env ]; then echo "deploy/.env already exists; leaving it unchanged."; exit 1; fi
key() { openssl rand -base64 32 | tr -d '\n'; }
umask 077
sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
    -e "s|^DIRECTORY_SECRET=.*|DIRECTORY_SECRET=$(key)|" \
    -e "s|^FILE_ENCRYPTION_KEY=.*|FILE_ENCRYPTION_KEY=$(key)|" .env.example > .env
echo "Created deploy/.env with new secrets. Set ACME_EMAIL and SERVED_REGIONS, then back the file up somewhere safe."
