# Firewall

SIP provider 203.76.101.50 -> Asterisk UDP 5060 (SIP)
Asterisk <-> SIP provider UDP 10000-10100 (RTP) - must be reachable from provider
Asterisk -> Node.js UDP 4000 (ExternalMedia RTP) - local, keep 127.0.0.1 or private net
Node.js TCP 5410 (recording upload + health) - localhost + optional private net, protected by Bearer token

UFW example:
```
ufw allow 5060/udp
ufw allow 10000:10100/udp
ufw allow from 203.76.101.50 to any port 5060 proto udp
ufw allow from 203.76.101.50 to any port 10000:10100 proto udp
ufw deny 8088/tcp  # ARI only localhost
ufw allow 5410/tcp  # restrict with token auth
```
If Node and Asterisk on same host, NODE_MEDIA_HOST=127.0.0.1 needs no firewall rule.
If separate hosts, open UDP 4000 between them.
