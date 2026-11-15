#!/bin/bash
# Pull-based deploys: the server checks origin/main and deploys a new commit by itself, with no GitHub Actions and no
# inbound SSH key. A systemd timer runs this every few minutes as ubuntu (deploy/systemd/, installed by
# install-auto-deploy.sh). It fetches with the server's read-only deploy key and hands the commit to remote-deploy.sh,
# which checks it out, rebuilds, restarts and waits for the health check.
# It compares origin/main with the last commit it deployed successfully (~/.lotuspond-deployed), not with the checkout:
# a git pull moves the checkout without rebuilding anything. With no record yet, the first run deploys origin/main.
# A commit that fails to deploy is not retried on every tick: the next new commit on main is tried instead.
# Run it by hand to deploy now: deploy/auto-deploy.sh. Log: journalctl -u lotuspond-auto-deploy. See deploy/ci-cd.md.
#
# Everything runs inside main(), which bash reads in full before running: the deploy rewrites this file.
main() {
  set -euo pipefail
  local repo=${LOTUSPOND_REPO:-/opt/lotuspond-health}
  local failed_file="$HOME/.lotuspond-deploy-failed"
  local deployed_file="$HOME/.lotuspond-deployed"
  local target current

  cd "$repo"
  git fetch --quiet origin main
  target=$(git rev-parse origin/main)
  current=$(cat "$deployed_file" 2>/dev/null || echo none)
  if [ "$target" = "$current" ]; then
    exit 0
  fi
  if [ -f "$failed_file" ] && [ "$(cat "$failed_file")" = "$target" ]; then
    echo "auto-deploy: $target failed before; waiting for a newer commit on main (or run remote-deploy.sh $target)."
    exit 0
  fi

  echo "auto-deploy: origin/main is $target, last deployed $current."
  if "$repo/deploy/remote-deploy.sh" "$target"; then
    echo "$target" > "$deployed_file"
    rm -f "$failed_file"
  else
    echo "$target" > "$failed_file"
    echo "auto-deploy: deploying $target failed; the stack keeps what docker compose left running." >&2
    exit 1
  fi
}
main "$@"
exit
