# Deploying LotusPond Health to health.lotuspond.ai

This folder runs the whole product on one server you control: PostgreSQL, the app (API, website and app pages), and [Caddy](https://caddyserver.com) for HTTPS. Caddy gets and renews the Let's Encrypt certificate for `health.lotuspond.ai` by itself.

## 1. Choose where the server runs

Sign-up tells every person where their records are stored. That promise is only true for the regions whose storage this server's location fulfils, so `SERVED_REGIONS` must match the server's location:

| Server location | `SERVED_REGIONS` | Who can sign up |
| --- | --- | --- |
| India (for example Mumbai) | `in` | People living in India |
| European Union (for example Frankfurt) | `eu` | EU/EEA, plus the UK and Switzerland (told their records are stored in the EU) |
| United States | `us` | US, plus Canada (told their records are stored in the US) |
| Your international location | `global` | Everyone else who is not covered by a cell above |

Anyone from a region this server does not hold sees why they cannot sign up yet; nothing is stored for them.

**Starting point:** one server in India with `SERVED_REGIONS=in`, since the partner labs start in India. On AWS, follow [`aws-lightsail.md`](aws-lightsail.md): an Amazon Lightsail instance in Mumbai, with backups to S3 in the same region. Add a server per region later, each with this same folder and its own `SERVED_REGIONS` and secrets. Then set `REGION_API_ORIGINS` so the mobile apps and sign-in know which host holds which region (see the main README, "Data residency" and "Mobile apps").

## 2. Prepare the server

- A Linux virtual machine with at least 2 vCPU, 4 GB RAM and 40 GB disk, with disk encryption turned on (most cloud providers do this by default).
- [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin.
- Ports 80 and 443 open to the internet.
- A DNS record pointing `health.lotuspond.ai` to the server's public address: an `A` record (and `AAAA` for IPv6). Caddy can only get the certificate once this resolves.

## 3. Configure

```bash
git clone https://github.com/lotuspond-ai/lotuspond-health.git
```

```bash
cd lotuspond-health/deploy
```

```bash
./make-secrets.sh
```

Then edit `deploy/.env`:

- `ACME_EMAIL`: where Let's Encrypt sends certificate notices.
- `SERVED_REGIONS`: from the table above.
- `GRIEVANCE_CONTACT`: required for India by the DPDP Act. Also set `DPO_CONTACT`.
- `GEO_CONTACT_EMAIL`: OpenStreetMap's place search asks apps for a contact address.

**Back up `deploy/.env` somewhere safe, outside the server**, for example a password manager or a secret store. It holds the database password, the directory secret and the file key. Without `DIRECTORY_SECRET`, accounts cannot be found at sign-in; without `FILE_ENCRYPTION_KEY`, uploaded files cannot be read.

## 4. Start

```bash
docker compose up -d --build
```

```bash
docker compose logs -f app
```

When the log shows `LotusPond Health API on …` and Caddy has its certificate, open https://health.lotuspond.ai. Database migrations run automatically on every start.

## 5. Partner labs

Prepare a JSON file in the format described in `server/data/README.md`, then check and import it:

```bash
docker compose cp partners.json app:/tmp/partners.json
```

```bash
docker compose exec app node dist/facilities/import-cli.js /tmp/partners.json --check
```

```bash
docker compose exec app node dist/facilities/import-cli.js /tmp/partners.json
```

Importing again with the same file updates the existing entries; it does not create duplicates.

## 6. Updates

To deploy automatically on every push to `main` (and `development` to a staging server), set up [`ci-cd.md`](ci-cd.md). By hand:

```bash
git pull
```

```bash
docker compose up -d --build
```

## 7. Backups

`./backup.sh` writes a database dump and an archive of the uploaded files (still encrypted) to `deploy/backups/`, and keeps 14 days. Run it nightly and copy the folder off the server. For example, in `crontab -e`:

```
30 2 * * * /path/to/lotuspond-health/deploy/backup.sh >> /var/log/lotuspond-backup.log 2>&1
```

To restore a database dump into a fresh stack:

```bash
docker compose exec -T db pg_restore -U lotuspond -d lotuspond --clean --if-exists < backups/db-YYYYMMDD-HHMMSS.dump
```

## Notes

- **Place search at scale:** nearby lab search and area search use OpenStreetMap's public Overpass and Nominatim services, which have usage limits. For real traffic, run your own instances or use a commercial provider, and point `OVERPASS_URL` and `GEOCODER_URL` at them.
- **Map tiles:** self-hosted map tiles are optional; see `tools/maps/README.md`.
- **Rotating the file key:** see the main README, "Rotating the file key".
- **Before inviting real users,** fill in the marked placeholders on the Privacy, Terms and Trust pages and have them reviewed for each market you open.
