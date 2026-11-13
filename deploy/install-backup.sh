#!/bin/sh
# Install (or update) the nightly backup timer on the server, and age for the encrypted off-server copies. Run once
# from the repository, as root:
#   sudo /opt/lotuspond-health/deploy/install-backup.sh
# Run it again after changing deploy/systemd/. To run a backup now: sudo systemctl start lotuspond-backup
# To stop nightly backups: sudo systemctl disable --now lotuspond-backup.timer
set -eu
here=$(cd "$(dirname "$0")" && pwd)
command -v age >/dev/null || { apt-get update -q && apt-get install -y -q age; }
install -m 644 "$here/systemd/lotuspond-backup.service" /etc/systemd/system/
install -m 644 "$here/systemd/lotuspond-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lotuspond-backup.timer
systemctl list-timers lotuspond-backup.timer --no-pager
echo "Nightly backups are on. Log: journalctl -u lotuspond-backup"
