#!/bin/sh
# First-boot setup for an Amazon Lightsail (or EC2) Ubuntu 24.04 instance that will run LotusPond Health.
# Paste it as the "launch script" when creating the instance, or run it once as root: sudo sh aws-lightsail-init.sh
# It installs Docker with the Compose plugin, adds 2 GB of swap (the image build needs headroom on 4 GB),
# and clones the repository to /opt/lotuspond-health. It does not create secrets or start the app;
# follow deploy/aws-lightsail.md from step 4. Safe to run again.
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 git openssl unattended-upgrades
systemctl enable --now docker

# Let the default Lightsail user run docker without sudo.
if id ubuntu >/dev/null 2>&1; then usermod -aG docker ubuntu; fi

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -d /opt/lotuspond-health/.git ]; then
  git clone https://github.com/lotuspond-ai/lotuspond-health.git /opt/lotuspond-health
fi
if id ubuntu >/dev/null 2>&1; then chown -R ubuntu:ubuntu /opt/lotuspond-health; fi

echo "Ready. Next: cd /opt/lotuspond-health/deploy && ./make-secrets.sh (see deploy/aws-lightsail.md)."
