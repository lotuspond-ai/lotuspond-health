#!/bin/bash
# Pull-based deploys: the server checks its branch (origin/main, or origin/development on staging) and deploys a new commit by itself, with no GitHub Actions and no
# inbound SSH key. A systemd timer runs this every few minutes as ubuntu (deploy/systemd/, installed by
# install-auto-deploy.sh). It fetches with the server's read-only deploy key and hands the commit to remote-deploy.sh,
# which checks it out, rebuilds, restarts and waits for the health check.
# It compares the branch with the last commit it deployed successfully (~/.lotuspond-deployed), not with the checkout:
# a git pull moves the checkout without rebuilding anything. With no record yet, the first run deploys the branch.
# A commit that fails to deploy is not retried on every tick: the next new commit on the branch is tried instead.
# The branch is DEPLOY_BRANCH in deploy/.env: `development` on the staging server, `main` (the default) everywhere else.
# Run it by hand to deploy now: deploy/auto-deploy.sh. Log: journalctl -u lotuspond-auto-deploy. See deploy/ci-cd.md.
#
# Everything runs inside main(), which bash reads in full before running: the deploy rewrites this file.
main() {
  set -euo pipefail
  local repo=${LOTUSPOND_REPO:-/opt/lotuspond-health}
  local failed_file="$HOME/.lotuspond-deploy-failed"
  local deployed_file="$HOME/.lotuspond-deployed"
  local target current branch

  cd "$repo"
  # Read, not sourced: deploy/.env holds secrets and is not a shell script.
  branch=$(sed -n 's/^DEPLOY_BRANCH=//p' deploy/.env 2>/dev/null | tail -n 1 | tr -d '"'"'"'\r ')
  branch=${branch:-main}
  case "$branch" in
    main|development) ;;
    *) echo "auto-deploy: DEPLOY_BRANCH must be main or development, not '$branch'." >&2; exit 1 ;;
  esac
  git fetch --quiet origin "$branch"
  target=$(git rev-parse "origin/$branch")
  current=$(cat "$deployed_file" 2>/dev/null || echo none)
  if [ "$target" = "$current" ]; then
    exit 0
  fi
  if [ -f "$failed_file" ] && [ "$(cat "$failed_file")" = "$target" ]; then
    echo "auto-deploy: $target failed before; waiting for a newer commit on $branch (or run remote-deploy.sh $target)."
    exit 0
  fi

  echo "auto-deploy: origin/$branch is $target, last deployed $current."
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
