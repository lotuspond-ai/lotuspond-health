#!/bin/bash
# Create the LotusPond Health server on Amazon Lightsail in Mumbai, from AWS CloudShell (or any shell with the AWS CLI
# signed in to your account). It creates the instance (Ubuntu 24.04, 4 GB / 2 vCPU, $24/month) with the first-boot
# script, daily automatic snapshots, a static IP and the firewall rules, then prints the IP for the DNS record.
# Run it once: bash deploy/aws-lightsail-create.sh   (or paste it into CloudShell). See deploy/aws-lightsail.md.
set -euo pipefail

REGION=ap-south-1
NAME=${NAME:-lotuspond-health-in}
ZONE=${ZONE:-ap-south-1a}
export AWS_DEFAULT_REGION=$REGION

# Look the IDs up rather than hard-coding them: the 4 GB Linux bundle and the Ubuntu 24.04 blueprint.
BUNDLE=$(aws lightsail get-bundles --query "bundles[?ramSizeInGb==\`4.0\` && cpuCount==\`2\` && isActive && contains(supportedPlatforms,'LINUX_UNIX') && price==\`24.0\`].bundleId | [0]" --output text)
BLUEPRINT=$(aws lightsail get-blueprints --query "blueprints[?isActive && starts_with(blueprintId,'ubuntu_24_04')].blueprintId | [0]" --output text)
echo "Bundle: $BUNDLE  Blueprint: $BLUEPRINT"
if [ "$BUNDLE" = "None" ] || [ "$BLUEPRINT" = "None" ]; then echo "Could not find the bundle or blueprint; stopping." >&2; exit 1; fi

# First-boot script (same as deploy/aws-lightsail-init.sh): Docker + Compose, 2 GB swap, clone the repo.
cat > /tmp/lotuspond-init.sh <<'INIT'
#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 git openssl unattended-upgrades
systemctl enable --now docker
if id ubuntu >/dev/null 2>&1; then usermod -aG docker ubuntu; fi
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# The repository is private: without a deploy key this clone fails, and you clone it yourself (aws-lightsail.md, step 4).
if [ ! -d /opt/lotuspond-health/.git ]; then
  GIT_TERMINAL_PROMPT=0 git clone https://github.com/lotuspond-ai/lotuspond-health.git /opt/lotuspond-health \
    || echo "Repository not cloned (private); add a deploy key and clone it, see deploy/aws-lightsail.md step 4."
fi
if id ubuntu >/dev/null 2>&1 && [ -d /opt/lotuspond-health ]; then chown -R ubuntu:ubuntu /opt/lotuspond-health; fi
INIT

if aws lightsail get-instance --instance-name "$NAME" >/dev/null 2>&1; then
  echo "Instance $NAME already exists; skipping creation."
else
  # Snapshot time is UTC: 21:00 UTC is 02:30 in India.
  aws lightsail create-instances --instance-names "$NAME" --availability-zone "$ZONE" \
    --blueprint-id "$BLUEPRINT" --bundle-id "$BUNDLE" --ip-address-type dualstack \
    --user-data file:///tmp/lotuspond-init.sh \
    --add-ons 'addOnType=AutoSnapshot,autoSnapshotAddOnRequest={snapshotTimeOfDay=21:00}' \
    --tags key=project,value=lotuspond-health >/dev/null
  echo "Creating $NAME…"
fi

until [ "$(aws lightsail get-instance-state --instance-name "$NAME" --query state.name --output text)" = running ]; do sleep 5; done
echo "$NAME is running."

if ! aws lightsail get-static-ip --static-ip-name "$NAME-ip" >/dev/null 2>&1; then
  aws lightsail allocate-static-ip --static-ip-name "$NAME-ip" >/dev/null
fi
aws lightsail attach-static-ip --static-ip-name "$NAME-ip" --instance-name "$NAME" >/dev/null 2>&1 || true

# Firewall: SSH, HTTP, HTTPS and HTTP/3, over IPv4 and IPv6. This replaces the instance's port list.
aws lightsail put-instance-public-ports --instance-name "$NAME" --port-infos \
  'fromPort=22,toPort=22,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0' \
  'fromPort=80,toPort=80,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0' \
  'fromPort=443,toPort=443,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0' \
  'fromPort=443,toPort=443,protocol=udp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0' >/dev/null

IPV4=$(aws lightsail get-static-ip --static-ip-name "$NAME-ip" --query staticIp.ipAddress --output text)
IPV6=$(aws lightsail get-instance --instance-name "$NAME" --query 'instance.ipv6Addresses[0]' --output text)
echo
echo "Done. Static IPv4: $IPV4"
echo "IPv6: $IPV6"
echo "Point health.lotuspond.ai at these (A and AAAA), then continue with deploy/aws-lightsail.md step 4."
