# Automatic deploys from GitHub

There are two ways to deploy every commit on `main`. Production uses the first: GitHub Actions checks each commit, then deploys it over SSH. It has worked since 17 November 2026, when the repository was made public and Actions jobs could start. Before that, production used the second route, where the server pulls `main` by itself; keep that one for a time when Actions can't run.

## Production: GitHub Actions checks, then deploys

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs on every push to `main` and `development`, and can be run by hand from the **Actions** tab (**Deploy → Run workflow**):

1. **Checks:** `npm ci`, the headless Chromium build that `playwright-core` expects (the record agent's tests drive a real browser), lint, typecheck and the full test suite. A failure stops the deploy.
2. **Deploy:** GitHub Actions connects to the server over SSH and runs [`remote-deploy.sh`](remote-deploy.sh) with the commit to deploy. The script checks the commit is on `origin/main` or `origin/development`, checks it out, rebuilds and restarts the stack (`docker compose up -d --build`; database migrations run on start), and waits for the app's health check.
3. **Check:** the workflow calls `DEPLOY_URL/api/health` until it answers.

Pull requests run step 1 only, so a change is checked before it reaches `main`. The deploy job is skipped for every pull request, whatever its branch.

| Branch | GitHub environment | Server |
| --- | --- | --- |
| `main` | `production` | https://health.lotuspond.ai |
| `development` | `staging` | a second server, e.g. https://staging.health.lotuspond.ai |

An environment without `DEPLOY_HOST` is skipped with a notice, so staging stays off until it has a server. Deploys to one server never overlap: a newer push waits for the running deploy. A run on any other branch runs the checks only. The production environment, its key and its settings were set up as described below on 12 November 2026; the first deploy through this route was [run 44148832015](https://github.com/lotuspond-ai/lotuspond-health/actions/runs/44148832015).

**Only one route at a time.** If the server's pull timer from the route below is still installed, turn it off on the server, so the two routes never deploy at once:

```bash
sudo systemctl disable --now lotuspond-auto-deploy.timer
```

## Fallback: the server pulls `main`

Use this only while GitHub Actions jobs can't run (for example, if the repository becomes private again on an organization without Actions minutes). [`auto-deploy.sh`](auto-deploy.sh) runs on the server every 5 minutes from a systemd timer ([`systemd/`](systemd/)). It fetches its branch (`origin/main`, or `origin/development` where `deploy/.env` sets `DEPLOY_BRANCH=development`) with the server's read-only deploy key. When that branch has a commit the server isn't running, it passes it to [`remote-deploy.sh`](remote-deploy.sh), which checks it out, rebuilds, restarts and waits for the health check. It needs no GitHub Actions minutes, no GitHub secrets and no inbound SSH key.

**Nothing checks a commit before it goes live on this route:** no lint, typecheck or tests run first. Merge to `main` only through reviewed pull requests, and run `npm run lint`, `npm run typecheck` and `npm test` before merging. It also failed silently once: from 12 to 17 November 2026 the timer deployed nothing, and the cause was never found. Check `journalctl -u lotuspond-auto-deploy` whenever you rely on it.

Install it, in the server's browser SSH, as `ubuntu`:

```bash
cd /opt/lotuspond-health && git pull --ff-only origin main
```

```bash
sudo /opt/lotuspond-health/deploy/install-auto-deploy.sh
```

| Task | Command on the server |
| --- | --- |
| Follow deploys | `journalctl -u lotuspond-auto-deploy -f` |
| Deploy now | `/opt/lotuspond-health/deploy/auto-deploy.sh` |
| Pause | `sudo systemctl disable --now lotuspond-auto-deploy.timer` |
| Resume | `sudo systemctl enable --now lotuspond-auto-deploy.timer` |

The script remembers the last commit it deployed in `~/.lotuspond-deployed`. A `git pull` alone deploys nothing, so the timer still deploys the pulled commit. A deploy run by hand with `remote-deploy.sh` isn't recorded, so the timer then deploys `main` once more. A commit that fails to deploy is tried only once. The timer waits for the next commit on `main`, or you can run `deploy/remote-deploy.sh <sha>` by hand. To roll back, revert on `main`: the server deploys the revert within a few minutes.

## Set up the GitHub Actions route (once)

The server must already be running by hand: [`aws-lightsail.md`](aws-lightsail.md) through step 4, with `deploy/.env` in place and the repository cloned with its deploy key.

### 1. A key that can only deploy

On the server, as `ubuntu`:

```bash
ssh-keygen -t ed25519 -N "" -f ~/github-actions -C github-actions
```

```bash
echo "command=\"/opt/lotuspond-health/deploy/remote-deploy.sh\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $(cat ~/github-actions.pub)" >> ~/.ssh/authorized_keys
```

Print the private key, to copy into GitHub in the next step, and then delete it from the server:

```bash
cat ~/github-actions
```

```bash
rm ~/github-actions ~/github-actions.pub
```

Print the server's host key line, which lets GitHub Actions check that it reaches the real server (replace the address with your static IP):

```bash
echo "13.200.0.1 $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
```

### 2. The `production` environment on GitHub

In the repository: **Settings → Environments → New environment → `production`**.

- **Deployment branches:** Selected branches → `main`.
- **Environment secrets:**
  - `DEPLOY_SSH_KEY`: the whole private key from step 1, including the `BEGIN` and `END` lines.
  - `DEPLOY_KNOWN_HOSTS`: the host key line from step 1.
- **Environment variables:**
  - `DEPLOY_HOST`: the static IP.
  - `DEPLOY_URL`: `https://health.lotuspond.ai`.
  - `DEPLOY_USER`: only if it is not `ubuntu`.
- **Required reviewers** (optional): add yourself to approve each production deploy before it runs.

The next push to `main` deploys. To deploy without a push, run the workflow from the **Actions** tab (**Deploy → Run workflow**).

## Set up staging (when you want it)

Staging needs its own server, because a deploy rebuilds the whole stack on its server.

1. Create a second instance the same way (for example `NAME=lotuspond-health-staging` with `aws-lightsail-create.sh`), with its own `deploy/.env` from `make-secrets.sh` and `DOMAIN=staging.health.lotuspond.ai`. Use test data only: never copy production records or secrets to staging.
2. Point `staging.health.lotuspond.ai` at it.
3. Create a `development` branch from `main`, and a `staging` environment on GitHub limited to `development`, with the same four settings for the staging server.

**Staging with pull-based deploys** (the server's read-only deploy key, no GitHub secrets): add `DEPLOY_BRANCH=development` to the staging server's `deploy/.env`, so [`auto-deploy.sh`](auto-deploy.sh) follows `development` instead of `main`. Production leaves it unset (or `main`). Pull requests merge into `development` first and reach `main` only when they are ready for production (settled by the owner, 2026-11-18). On a staging server set up before this setting existed, deploy `development` once by hand so its checkout has the new script, then turn the timer on:

```bash
cd /opt/lotuspond-health && echo DEPLOY_BRANCH=development >> deploy/.env
git fetch origin development && deploy/remote-deploy.sh "$(git rev-parse origin/development)"
sudo deploy/install-auto-deploy.sh
```

## Notes

- **Every merge to `main` goes live.** Protect `main` (Settings → Branches: require a pull request) so nothing reaches it unreviewed. The workflow runs on pushes, not on pull requests, so its "Lint, typecheck and tests" check can't be a required status check. Run it on the branch before merging with **Deploy → Run workflow**, choosing the branch: on a branch it runs the checks and skips the deploy.
- **Rolling back:** revert the commit on `main` and push; or on the server run `deploy/remote-deploy.sh <older sha>` (the commit must still be on `main`). Database migrations are not rolled back, so a change that alters the schema needs a forward fix.
- **Brief downtime:** the app container restarts at the end of each deploy, typically for a few seconds. The image is built before the old container stops.
- **What the key can do:** only run `remote-deploy.sh` with a commit SHA. It cannot open a shell, forward ports, or deploy a commit that is not on `main` or `development`.
