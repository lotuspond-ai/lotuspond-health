# Automatic deploys from GitHub

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs on every push to `main` and `development`:

1. **Checks:** `npm ci`, lint, typecheck and the full test suite. A failure stops the deploy.
2. **Deploy:** GitHub Actions connects to the server over SSH and runs [`remote-deploy.sh`](remote-deploy.sh) with the commit to deploy. The script checks the commit is on `origin/main` or `origin/development`, checks it out, rebuilds and restarts the stack (`docker compose up -d --build`; database migrations run on start), and waits for the app's health check.
3. **Check:** the workflow calls `DEPLOY_URL/api/health` until it answers.

| Branch | GitHub environment | Server |
| --- | --- | --- |
| `main` | `production` | https://health.lotuspond.ai |
| `development` | `staging` | a second server, e.g. https://staging.health.lotuspond.ai |

An environment without `DEPLOY_HOST` is skipped with a notice, so staging stays off until it has a server. Deploys to one server never overlap: a newer push waits for the running deploy.

## Set up production (once)

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

## Notes

- **Every merge to `main` goes live.** Protect `main` (Settings → Branches: require a pull request, and the "Lint, typecheck and tests" check) so nothing reaches it unreviewed.
- **Rolling back:** revert the commit on `main` and push; or on the server run `deploy/remote-deploy.sh <older sha>` (the commit must still be on `main`). Database migrations are not rolled back, so a change that alters the schema needs a forward fix.
- **Brief downtime:** the app container restarts at the end of each deploy, typically for a few seconds. The image is built before the old container stops.
- **What the key can do:** only run `remote-deploy.sh` with a commit SHA. It cannot open a shell, forward ports, or deploy a commit that is not on `main` or `development`.
