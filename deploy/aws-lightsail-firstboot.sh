#!/bin/bash
# First-boot script for the LotusPond Health Lightsail server (Ubuntu 24.04), used by aws-lightsail-cfn.sh.
# This file is a template: aws-lightsail-cfn.sh fills in the deploy key and the ACME email (the two placeholders below)
# and passes the result to CloudFormation as a hidden parameter. Never commit a filled-in copy: it holds the private key.
# Same setup as aws-lightsail-init.sh, plus it installs the read-only GitHub deploy key, keeps retrying the clone
# until the key is added on GitHub (every minute, up to 12 hours), creates deploy/.env with fresh secrets
# (SERVED_REGIONS=in), and starts the stack. Log on the server: /var/log/lotuspond-firstboot.log
set -eu
exec >>/var/log/lotuspond-firstboot.log 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 git openssl unattended-upgrades
systemctl enable --now docker
usermod -aG docker ubuntu
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
umask 077
cat > /home/ubuntu/.ssh/lotuspond_deploy <<'KEY'
__DEPLOY_KEY__
KEY
umask 022
chown ubuntu:ubuntu /home/ubuntu/.ssh/lotuspond_deploy
install -d -o ubuntu -g ubuntu /opt/lotuspond-health

cat > /usr/local/sbin/lotuspond-bootstrap <<'BOOT'
#!/bin/bash
set -eu
REPO=/opt/lotuspond-health
SSHCMD="ssh -i /home/ubuntu/.ssh/lotuspond_deploy -o StrictHostKeyChecking=accept-new"
for i in $(seq 1 720); do
  [ -d $REPO/.git ] && break
  if sudo -u ubuntu env GIT_SSH_COMMAND="$SSHCMD" git clone git@github.com:lotuspond-ai/lotuspond-health.git $REPO; then break; fi
  echo "$(date -u +%FT%TZ) clone failed: add the deploy key on GitHub; retrying in 60 s"; sleep 60
done
[ -d $REPO/.git ] || { echo "gave up cloning"; exit 1; }
sudo -u ubuntu git -C $REPO config core.sshCommand "ssh -i /home/ubuntu/.ssh/lotuspond_deploy"
cd $REPO/deploy
if [ ! -f .env ]; then
  sudo -u ubuntu ./make-secrets.sh
  sed -i -e 's|^ACME_EMAIL=.*|ACME_EMAIL=__ACME_EMAIL__|' -e 's|^SERVED_REGIONS=.*|SERVED_REGIONS=in|' \
         -e 's|^# GEO_CONTACT_EMAIL=.*|GEO_CONTACT_EMAIL=__ACME_EMAIL__|' .env
fi
docker compose up -d --build
echo "$(date -u +%FT%TZ) LotusPond Health stack started"
BOOT
chmod 755 /usr/local/sbin/lotuspond-bootstrap
systemd-run --unit=lotuspond-bootstrap --property=StandardOutput=append:/var/log/lotuspond-firstboot.log \
  --property=StandardError=append:/var/log/lotuspond-firstboot.log /usr/local/sbin/lotuspond-bootstrap
echo "first boot done; bootstrap running as lotuspond-bootstrap.service"
