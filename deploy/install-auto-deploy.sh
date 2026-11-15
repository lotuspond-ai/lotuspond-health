#!/bin/sh
# Install (or update) the pull-based deploy timer on the server. Run once from the repository, as root:
#   sudo /opt/lotuspond-health/deploy/install-auto-deploy.sh
# Run it again after changing deploy/systemd/. To stop automatic deploys:
#   sudo systemctl disable --now lotuspond-auto-deploy.timer
set -eu
here=$(cd "$(dirname "$0")" && pwd)
install -m 644 "$here/systemd/lotuspond-auto-deploy.service" /etc/systemd/system/
install -m 644 "$here/systemd/lotuspond-auto-deploy.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lotuspond-auto-deploy.timer
systemctl list-timers lotuspond-auto-deploy.timer --no-pager
echo "Automatic deploys are on. Log: journalctl -u lotuspond-auto-deploy -f"
