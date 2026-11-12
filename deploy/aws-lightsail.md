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

Lightsail snapshots cover a lost instance. For a copy outside the instance, sync `deploy/backups/` to S3:

1. In the AWS console, create an S3 bucket in **Asia Pacific (Mumbai), ap-south-1**, with public access blocked and default encryption on. Add a lifecycle rule that expires objects after, for example, 30 days.
2. In IAM, create a user for this server only, with a policy that allows `s3:ListBucket` on the bucket and `s3:PutObject` on its objects. Create an access key for it.
3. On the server, put the key in `~/.aws/credentials` (readable only by you) and the region in `~/.aws/config`:

   ```
   [default]
   aws_access_key_id = …
   aws_secret_access_key = …
   ```

   ```
   [default]
   region = ap-south-1
   ```

4. Run the nightly backup with `BACKUP_S3_URI` set (`crontab -e`):

   ```
   30 2 * * * BACKUP_S3_URI=s3://your-bucket/health /opt/lotuspond-health/deploy/backup.sh >> $HOME/lotuspond-backup.log 2>&1
   ```

The database dump holds the records unencrypted (uploaded files stay encrypted), which is why the bucket must be private and in India.

## 6. Updates

```bash
cd /opt/lotuspond-health && git pull && cd deploy && docker compose up -d --build
```

## When to grow

- **More load:** move to the 8 GB plan from a snapshot (create a new instance from the snapshot on the larger plan, then move the static IP to it).
- **Managed database:** a Lightsail managed PostgreSQL database in Mumbai (or Amazon RDS) takes over backups and patching. Set `DATABASE_URL` in `.env` to it and drop the `db` service.
- **Several app servers:** the uploaded files live on the instance disk. Before running more than one app server, move them to object storage (see "Files" in the main README).
