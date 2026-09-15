#!/bin/bash
set -e
apt update
apt install -y asterisk nodejs npm curl sox
mkdir -p /var/spool/asterisk/recordings
chown -R asterisk:asterisk /var/spool/asterisk/recordings
cp asterisk/pjsip.conf /etc/asterisk/pjsip.conf
cp asterisk/extensions.conf /etc/asterisk/extensions.conf
cp asterisk/rtp.conf /etc/asterisk/rtp.conf
cp asterisk/ari.conf /etc/asterisk/ari.conf
cp asterisk/http.conf /etc/asterisk/http.conf
cp scripts/upload-recording.sh /usr/local/bin/upload-recording.sh
chmod +x /usr/local/bin/upload-recording.sh
systemctl enable asterisk
systemctl restart asterisk
asterisk -rx "pjsip reload"
asterisk -rx "dialplan reload"
echo "Asterisk ready - check: asterisk -rvvv , pjsip show registrations"
