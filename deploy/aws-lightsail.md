# Running LotusPond Health on Amazon Lightsail in Mumbai

This is the India server from [`README.md`](README.md) (`SERVED_REGIONS=in`) on AWS: one Lightsail instance in the Asia Pacific (Mumbai) region, `ap-south-1`, running this folder's stack (PostgreSQL, the app and Caddy). The records, the uploaded files and their backups all stay in India.

**Cost:** the Linux General Purpose plan with 4 GB RAM, 2 vCPU and 80 GB SSD is $24 a month, including a public IPv4 address. In Mumbai it includes 2 TB of data transfer a month (half the allowance of other regions). Automatic snapshots and an S3 bucket for backups add a few dollars. Check the [Lightsail pricing page](https://aws.amazon.com/lightsail/pricing/) for the current figures.

## Quick route: one script in AWS CloudShell

Steps 1 and 2 can be done in one go. Open [AWS CloudShell](https://console.aws.amazon.com/cloudshell/home?region=ap-south-1) (the terminal in the AWS console, already signed in), paste the contents of [`aws-lightsail-create.sh`](aws-lightsail-create.sh), and press Enter. It creates the instance with the first-boot script, daily automatic snapshots, a static IP and the firewall rules, then prints the IPv4 and IPv6 addresses for step 3. Running it again skips what already exists.

## CloudFormation route: steps 1, 2 and 4 in one stack

This is how the production server was created (stack `lotuspond-health-in`). [`aws-lightsail.cfn.yaml`](aws-lightsail.cfn.yaml) describes the same instance, snapshots, static IP and firewall as the steps below. [`aws-lightsail-firstboot.sh`](aws-lightsail-firstboot.sh) does step 4 by itself once the server can reach the repository. From a clone of this repository in CloudShell:

```bash
ACME_EMAIL=ops@lotuspond.ai bash deploy/aws-lightsail-cfn.sh
```

The script makes a new read-only deploy key and passes it to the stack inside the first-boot script, as a hidden (`NoEcho`) parameter. It prints the public key and the server's addresses. Then:

1. **Add the deploy key** on GitHub: repository **Settings → Deploy keys → Add deploy key**, with **Allow write access** off. If GitHub says deploy keys are disabled, an organization owner turns them on first: organization **Settings → Member privileges → Deploy keys → Enabled**. That setting applies to every repository in the organization.
2. **DNS** as in step 3.
3. **Wait.** The server tries the clone every minute for up to 12 hours. Once it works, the server creates `deploy/.env` with fresh secrets (`SERVED_REGIONS=in`, `ACME_EMAIL` and `GEO_CONTACT_EMAIL` from the script) and runs `docker compose up -d --build`. `https://health.lotuspond.ai/api/health` answers a few minutes later. The log is `/var/log/lotuspond-firstboot.log`.
4. **Back up `deploy/.env`** (browser SSH: `cat /opt/lotuspond-health/deploy/.env`). Add `GRIEVANCE_CONTACT` and `DPO_CONTACT` to it, then run `docker compose up -d` in `deploy/`.

Mumbai has its own bundle IDs: the 4 GB plan is `medium_3_1` there, and `medium_3_0` does not exist. To change the plan or firewall later, edit the template and update the stack, keeping the hidden parameter:

```bash
aws cloudformation update-stack --region ap-south-1 --stack-name lotuspond-health-in --template-body file://deploy/aws-lightsail.cfn.yaml --parameters ParameterKey=UserData,UsePreviousValue=true
```

CloudFormation does not support changing `BundleId`, `BlueprintId` or `AvailabilityZone` on an existing instance. Move to a larger plan from a snapshot instead (see "When to grow"). Ports, snapshots and tags update in place.

## 1. Create the instance

In the [Lightsail console](https://lightsail.aws.amazon.com/), choose **Create instance**:

1. **Location:** Mumbai, `ap-south-1` (any zone).
2. **Platform and blueprint:** Linux/Unix, **OS Only → Ubuntu 24.04 LTS**.
3. **Launch script:** paste the contents of [`aws-lightsail-init.sh`](aws-lightsail-init.sh). It installs Docker with the Compose plugin, adds swap and clones the repository to `/opt/lotuspond-health`. You can also run it later with `sudo sh aws-lightsail-init.sh`.
4. **SSH key:** use your own key pair, or download the default one and keep it safe.
5. **Plan:** dual-stack, General Purpose, **4 GB RAM, 2 vCPU, 80 GB SSD**.
6. **Automatic snapshots:** turn them on (instance page → Snapshots), so Lightsail keeps a daily copy of the whole disk in the same region.

## 2. Static IP and firewall

- **Networking → Create static IP**, in Mumbai, attached to the instance. A static IP is free while it is attached; without one the address changes when the instance stops.
- On the instance's **Networking** tab, keep SSH (22) and HTTP (80), and add **HTTPS (443, TCP)** and **443 UDP** (HTTP/3) for IPv4 and IPv6. Restrict SSH to your own address if you can.

## 3. DNS

Point `health.lotuspond.ai` at the static IP with an `A` record, plus an `AAAA` record for the instance's IPv6 address. If the domain's DNS is on Cloudflare, start with the record set to **DNS only** (grey cloud) so Caddy can get its certificate. You can turn the proxy on afterwards, with SSL/TLS mode **Full (strict)**.

## 4. Configure and start

Connect with SSH (or the console's browser terminal) and check that the launch script finished:

```bash
tail -n 5 /var/log/cloud-init-output.log
```

The repository is private, so the launch script cannot clone it. Give the server a read-only deploy key:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/lotuspond_deploy -C lotuspond-health-server
```

```bash
cat ~/.ssh/lotuspond_deploy.pub
```

On GitHub, open the repository's **Settings → Deploy keys → Add deploy key**, paste that public key, and leave **Allow write access** off. Then clone:

```bash
sudo mkdir -p /opt/lotuspond-health && sudo chown ubuntu:ubuntu /opt/lotuspond-health
```

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/lotuspond_deploy -o StrictHostKeyChecking=accept-new" git clone git@github.com:lotuspond-ai/lotuspond-health.git /opt/lotuspond-health
```

```bash
git -C /opt/lotuspond-health config core.sshCommand "ssh -i ~/.ssh/lotuspond_deploy"
```

Then follow [`README.md`](README.md) from step 3, in `/opt/lotuspond-health/deploy`:

```bash
cd /opt/lotuspond-health/deploy
```

```bash
./make-secrets.sh
```

Edit `.env` (`ACME_EMAIL`, `SERVED_REGIONS=in`, `GRIEVANCE_CONTACT`, `DPO_CONTACT`, `GEO_CONTACT_EMAIL`), **copy it to a password manager**, then start:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f app
```

The first build takes several minutes on this plan.

## 5. Off-server backups in S3 (Mumbai)

Lightsail's daily snapshot covers a lost instance, but it lives in the same account and region as the server. The nightly backup also puts an encrypted copy in S3:

- the database dump;
- the uploaded files (already encrypted with `FILE_ENCRYPTION_KEY`);
- `deploy/.env`, so the secrets survive the server.

Each file is encrypted with [age](https://age-encryption.org) to a public key before it leaves the server. The server cannot read its own backups; only the private key, kept offline, can. The server's AWS key may only add new objects: it cannot list, read or delete them.

**1. Make the backup key, on your own computer** (not the server):

```bash
age-keygen -o lotuspond-backup-key.txt
```

Keep `lotuspond-backup-key.txt` in a password manager or another offline place, and keep a second copy somewhere else. Without it no backup can be restored. The line `# public key: age1…` is the recipient for step 3.

**2. Create the bucket and the writer**, in AWS CloudShell in **Asia Pacific (Mumbai)**, signed in as an administrator (not the root user; see section 7):

```bash
git clone https://github.com/lotuspond-ai/lotuspond-health.git && cd lotuspond-health
aws cloudformation deploy --region ap-south-1 --stack-name lotuspond-health-backups \
  --template-file deploy/aws-backup-bucket.cfn.yaml --capabilities CAPABILITY_NAMED_IAM
aws cloudformation describe-stacks --region ap-south-1 --stack-name lotuspond-health-backups --query 'Stacks[0].Outputs'
```

The stack (`deploy/aws-backup-bucket.cfn.yaml`) creates:

- a bucket `lotuspond-health-backups-<account id>` in Mumbai: public access blocked, encrypted, versioned, HTTPS only, backups expiring after 35 days (`RetentionDays`);
- an IAM user `lotuspond-health-backup-writer` that may only add objects under `health/`.

It refuses to run in any other region. Then, in the IAM console, open that user and create an access key (use case: *Application running outside AWS*).

**3. Configure the server.** Over SSH (the Lightsail console's browser SSH works):

```bash
mkdir -p ~/.aws && chmod 700 ~/.aws
printf '[default]\nregion = ap-south-1\n' > ~/.aws/config
install -m 600 /dev/null ~/.aws/credentials && nano ~/.aws/credentials
```

Paste the key into the editor (typing it into a command would leave it in the shell history):

```
[default]
aws_access_key_id = AKIA…
aws_secret_access_key = …
```

Then add the two settings and turn the timer on:

```bash
cd /opt/lotuspond-health/deploy
printf 'BACKUP_S3_URI=%s\nBACKUP_AGE_RECIPIENT=%s\n' 's3://lotuspond-health-backups-<account id>/health' 'age1…' >> .env
sudo ./install-backup.sh
sudo systemctl start lotuspond-backup && journalctl -u lotuspond-backup --no-pager | tail
```

`install-backup.sh` installs age and a systemd timer that runs `deploy/backup.sh` every night at 20:30 UTC (02:00 in India), half an hour before the snapshot. The log should end with "Encrypted copies uploaded". If `BACKUP_S3_URI` is set without a valid `BACKUP_AGE_RECIPIENT`, the backup fails rather than upload anything unencrypted.

**Restore**, on a computer with the private key and AWS access to the bucket:

```bash
aws s3 cp s3://lotuspond-health-backups-<account id>/health/db-YYYYMMDD-HHMMSS.dump.age .
age -d -i lotuspond-backup-key.txt -o db.dump db-YYYYMMDD-HHMMSS.dump.age
```

Do the same for `files-….tgz.age` and `env-….age`. Then restore the dump as in [`README.md`](README.md), section 7, unpack the files archive into the app's `/data` volume, and use the `.env` on the new server. Try a restore once, on a scratch instance, before relying on it.

## 6. Updates

```bash
cd /opt/lotuspond-health && git pull && cd deploy && docker compose up -d --build
```

## 7. Before real users: account and compliance

- **Stop using the root user.** The account was set up and the stack created with the AWS root user. Turn on MFA for root, then create an everyday administrator with IAM Identity Center:
  1. In the console, open **IAM Identity Center** and choose **Enable**.
  2. Under **Users**, add yourself.
  3. Under **Permission sets**, create one from the predefined **AdministratorAccess** policy.
  4. Under **AWS accounts**, assign that user and permission set to this account.
  5. Sign in through the AWS access portal URL Identity Center shows. Lock the root user away and use it only for the few tasks that need it.

  For the AWS CLI, `aws configure sso` uses the same sign-in.
- **Grievance and data-protection contacts.** India's DPDP Act needs a published grievance contact. Add both to `deploy/.env`, then `docker compose up -d` in `deploy/` (the Account page shows them):

  ```
  GRIEVANCE_CONTACT=Name, Grievance Officer, grievance@lotuspond.ai
  DPO_CONTACT=Data Protection Officer, dpo@lotuspond.ai
  ```

- **A copy of `deploy/.env` off the server.** The nightly backup (section 5) uploads it encrypted. Also keep a copy of `DIRECTORY_SECRET` and `FILE_ENCRYPTION_KEY` with the backup key: without them neither the server nor a restore can read the files.

## When to grow

- **More load:** move to the 8 GB plan from a snapshot (create a new instance from the snapshot on the larger plan, then move the static IP to it).
- **Managed database:** a Lightsail managed PostgreSQL database in Mumbai (or Amazon RDS) takes over backups and patching. Set `DATABASE_URL` in `.env` to it and drop the `db` service.
- **Several app servers:** the uploaded files live on the instance disk. Before running more than one app server, move them to object storage (see "Files" in the main README).
