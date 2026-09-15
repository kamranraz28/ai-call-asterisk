import { config } from './src/config.js';
import fs from 'fs';
const c = config;
const pjsip = `[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060

[provider]
type=registration
transport=transport-udp
outbound_auth=provider_auth
server_uri=sip:${c.sip.server}
client_uri=sip:${c.sip.username}@${c.sip.server}
retry_interval=20
expiration=300
contact_user=${c.sip.username}
max_retries=10
auth_rejection_permanent=no
forbidden_retry_interval=10
fatal_retry_interval=10

[provider_auth]
type=auth
auth_type=userpass
username=${c.sip.username}
password=${c.sip.password}

[provider_aor]
type=aor
contact=sip:${c.sip.server}:5060
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
from_user=${c.sip.username}
from_domain=${c.sip.server}
dtmf_mode=rfc4733

[provider_identify]
type=identify
endpoint=provider_endpoint
match=${c.sip.server}

[anonymous]
type=endpoint
transport=transport-udp
context=incoming
disallow=all
allow=ulaw
allow=alaw
direct_media=no

[anonymous_identify]
type=identify
endpoint=anonymous
match=127.0.0.1
`;
fs.writeFileSync('/etc/asterisk/pjsip.conf', pjsip);
console.log("pjsip written");

const ari = `[general]
enabled=yes
pretty=yes
allowed_origins=*
[ari_user]
type=user
read_only=no
password=${c.ari.password}
password_format=plain
`;
fs.writeFileSync('/etc/asterisk/ari.conf', ari);
console.log("ari written");
