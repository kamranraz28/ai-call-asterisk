#!/bin/bash
set -e
# ONE-SHOT PRODUCTION DEPLOY FOR UBUNTU 22.04/24.04
# Run as root on clean server: bash deploy.sh
# This fills secrets, installs Asterisk+Node, configures firewall, starts services.

SIP_USERNAME="${SIP_USERNAME:-}"
SIP_PASSWORD="${SIP_PASSWORD:-}"
SIP_SERVER="${SIP_SERVER:-203.76.101.50}"
APP_DIR="/opt/gemini-bridge"

if [ "$EUID" -ne 0 ]; then echo "Run as root: sudo bash deploy.sh"; exit 1; fi

echo "=== Asterisk + Gemini Live - Minimal Deploy ==="
read -p "Gemini API Key (GEMINI_API_KEY): " GEMINI_API_KEY
if [ -z "$GEMINI_API_KEY" ]; then echo "GEMINI_API_KEY required"; exit 1; fi

GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.1-flash-live-preview}"
read -p "Gemini Model [$GEMINI_MODEL]: " INP; [ -n "$INP" ] && GEMINI_MODEL="$INP"

if [ -z "$SIP_USERNAME" ]; then
  read -p "SIP Username: " SIP_USERNAME
fi
if [ -z "$SIP_PASSWORD" ]; then
  read -s -p "SIP Password: " SIP_PASSWORD; echo ""
fi
if [ -z "$SIP_USERNAME" ] || [ -z "$SIP_PASSWORD" ]; then echo "SIP credentials required"; exit 1; fi
read -p "SIP Server [$SIP_SERVER]: " INP; [ -n "$INP" ] && SIP_SERVER="$INP"
read -p "External IP (for NAT, blank if no NAT): " SIP_EXTERNAL_IP

ARI_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
UPLOAD_TOKEN=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)

apt update
apt install -y asterisk nodejs npm curl sox openssl ufw

mkdir -p $APP_DIR/recordings /var/spool/asterisk/recordings
# copy files (assumes deploy.sh lives inside project root)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp -r "$SCRIPT_DIR/src" "$APP_DIR/"
cp -r "$SCRIPT_DIR/asterisk" "$APP_DIR/"
cp -r "$SCRIPT_DIR/scripts" "$APP_DIR/"
cp -r "$SCRIPT_DIR/systemd" "$APP_DIR/"
cp "$SCRIPT_DIR/package.json" "$APP_DIR/"
cp "$SCRIPT_DIR/.env.example" "$APP_DIR/.env.example"

cat > $APP_DIR/.env <<EOF
SIP_USERNAME=$SIP_USERNAME
SIP_PASSWORD=$SIP_PASSWORD
SIP_SERVER=$SIP_SERVER
SIP_EXTERNAL_IP=$SIP_EXTERNAL_IP
ARI_URL=http://127.0.0.1:8088
ARI_USER=ari_user
ARI_PASSWORD=$ARI_PASSWORD
GEMINI_API_KEY=$GEMINI_API_KEY
GEMINI_MODEL=$GEMINI_MODEL
GEMINI_LIVE_ENDPOINT=
NODE_HOST=0.0.0.0
NODE_MEDIA_HOST=127.0.0.1
NODE_MEDIA_PORT=4000
NODE_HTTP_PORT=5410
RECORDING_DIR=$APP_DIR/recordings
RECORDING_UPLOAD_TOKEN=$UPLOAD_TOKEN
STASIS_APP=gemini-live
EOF
chmod 600 $APP_DIR/.env

PJSIP_SIP_PASSWORD=$(printf '%s' "$SIP_PASSWORD" | sed 's/\$/\\$/g')

cat > /etc/asterisk/pjsip.conf <<EOF
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
local_net=0.0.0.0/0
$([ -n "$SIP_EXTERNAL_IP" ] && echo "external_media_address=$SIP_EXTERNAL_IP" || echo "; no NAT")
$([ -n "$SIP_EXTERNAL_IP" ] && echo "external_signaling_address=$SIP_EXTERNAL_IP" || echo "; no NAT")
[provider]
type=registration
transport=transport-udp
outbound_auth=provider_auth
server_uri=sip:$SIP_SERVER
client_uri=sip:$SIP_USERNAME@$SIP_SERVER
retry_interval=60
expiration=3600
contact_user=$SIP_USERNAME
[provider_auth]
type=auth
auth_type=userpass
username=$SIP_USERNAME
password=$PJSIP_SIP_PASSWORD
[provider_aor]
type=aor
contact=sip:$SIP_SERVER:5060
qualify_frequency=60
[provider_endpoint]
type=endpoint
transport=transport-udp
context=incoming
disallow=all
allow=ulaw
allow=alaw
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
timers=yes
aors=provider_aor
outbound_auth=provider_auth
from_user=$SIP_USERNAME
from_domain=$SIP_SERVER
dtmf_mode=rfc4733
[provider_identify]
type=identify
endpoint=provider_endpoint
match=$SIP_SERVER
EOF

cat > /etc/asterisk/ari.conf <<EOF
[general]
enabled=yes
pretty=yes
allowed_origins=*
[ari_user]
type=user
read_only=no
password=$ARI_PASSWORD
password_format=plain
EOF

cat /etc/asterisk/http.conf 2>/dev/null | grep -q "8088" || cat > /etc/asterisk/http.conf <<'EOF'
[general]
enabled=yes
bindaddr=127.0.0.1
bindport=8088
pretty=yes
EOF

cp "$APP_DIR/asterisk/extensions.conf" /etc/asterisk/extensions.conf
cp "$APP_DIR/asterisk/rtp.conf" /etc/asterisk/rtp.conf
chown -R asterisk:asterisk /var/spool/asterisk/recordings
chmod 750 /var/spool/asterisk/recordings

cat > /usr/local/bin/upload-recording.sh <<EOSH
#!/bin/bash
set -e
CALL_ID="\$1"; CALLER="\$2"; DEST="\$3"; FILE="\$4"
set -a; source $APP_DIR/.env; set +a
URL="http://127.0.0.1:\${NODE_HTTP_PORT}/api/recordings"
[ -f "\$FILE" ] || exit 0
STARTED=\$(stat -c %y "\$FILE" 2>/dev/null || echo "")
ENDED=\$(date -Iseconds)
DURATION=\$(soxi -D "\$FILE" 2>/dev/null || echo "")
for i in 1 2 3; do
  if curl -fsS -X POST "\$URL" -H "Authorization: Bearer \${RECORDING_UPLOAD_TOKEN}" -F "call_id=\${CALL_ID}" -F "caller=\${CALLER}" -F "destination=\${DEST}" -F "started_at=\${STARTED}" -F "ended_at=\${ENDED}" -F "duration=\${DURATION}" -F "recording=@\${FILE}"; then echo "RECORDING_UPLOADED \$CALL_ID"; exit 0; fi
  sleep \$((i*2))
done
echo "RECORDING_UPLOAD_FAILED \$CALL_ID" >&2; exit 0
EOSH
chmod +x /usr/local/bin/upload-recording.sh

cd $APP_DIR && npm install --omit=dev

cat > /etc/systemd/system/gemini-bridge.service <<EOF
[Unit]
Description=Asterisk Gemini Live Bridge
After=network.target asterisk.service
Wants=asterisk.service
[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
EnvironmentFile=$APP_DIR/.env
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable asterisk
systemctl restart asterisk
sleep 3
asterisk -rx "pjsip reload" || true
asterisk -rx "dialplan reload" || true
systemctl enable --now gemini-bridge

# firewall (optional, non-blocking)
ufw allow 5060/udp 2>/dev/null || true
ufw allow 10000:10100/udp 2>/dev/null || true
ufw allow 5410/tcp 2>/dev/null || true

echo ""
echo "=== DONE ==="
echo "ARI password: $ARI_PASSWORD (saved in $APP_DIR/.env)"
echo "Upload token: $UPLOAD_TOKEN"
echo "Check SIP: asterisk -rx 'pjsip show registrations'  (should be Registered)"
echo "Check Node: curl http://127.0.0.1:5410/health"
echo "Logs: journalctl -u gemini-bridge -f"
echo "Call $SIP_USERNAME now to test. Speak, interrupt AI mid-sentence, hangup, then ls $APP_DIR/recordings/*/*.wav"
echo ""
asterisk -rx "pjsip show registrations" || true
curl -s http://127.0.0.1:5410/health || echo "Node starting..."
