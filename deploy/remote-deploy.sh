#!/bin/bash
# Deploys one commit on this server. GitHub Actions runs it over SSH (.github/workflows/deploy.yml) with a key whose
# authorized_keys entry forces this script, so that key can do nothing else:
#   command="/opt/lotuspond-health/deploy/remote-deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA… github-actions
# The only input is the commit SHA (in SSH_ORIGINAL_COMMAND). It must be on origin/main or origin/development.
# You can also run it by hand: deploy/remote-deploy.sh <sha>. See deploy/ci-cd.md.
#
# Everything runs inside main(), which bash reads in full before running: the checkout below rewrites this file.
main() {
  set -euo pipefail
  local repo=/opt/lotuspond-health
  local sha=${SSH_ORIGINAL_COMMAND:-${1:-}}

  if ! [[ $sha =~ ^[0-9a-f]{40}$ ]]; then
    echo "remote-deploy: expected a 40-character commit SHA, got '${sha}'." >&2
    exit 2
  fi

  # One deploy at a time.
  exec 9>/tmp/lotuspond-deploy.lock
  flock 9

  cd "$repo"
  git fetch --quiet origin main development 2>/dev/null || git fetch --quiet origin main
  if ! git branch -r --contains "$sha" 2>/dev/null | grep -qE '^\s*origin/(main|development)$'; then
    echo "remote-deploy: $sha is not on origin/main or origin/development; refusing." >&2
    exit 3
  fi

  echo "remote-deploy: deploying $sha (was $(git rev-parse --short HEAD 2>/dev/null || echo none))."
  git checkout --quiet --force --detach "$sha"

  cd deploy
  docker compose up -d --build --remove-orphans
  docker image prune -f >/dev/null

  # Wait for the app's own health check (Dockerfile HEALTHCHECK) before reporting success.
  local id status
  id=$(docker compose ps -q app)
  for _ in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo unknown)
    if [ "$status" = healthy ]; then
      echo "remote-deploy: $sha is live."
      exit 0
    fi
    sleep 5
  done
  echo "remote-deploy: the app did not become healthy (status: $status). Recent log:" >&2
  docker compose logs --tail 50 app >&2
  exit 1
}
main "$@"
exit
