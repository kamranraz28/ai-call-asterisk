# Asterisk + Node.js + Gemini Live — Real-time AI Phone Assistant

A minimal, production-style proof-of-concept for a **real-time AI phone system** built with **Asterisk (PJSIP + ARI)** and **Node.js** streaming live audio to **Gemini Live API**.

> The live AI conversation and the call recording are fully **independent**. The recording is never used as AI input — it is only uploaded to Node.js **after** the call ends.

```
SIP Provider
     │
  Asterisk
     ├── LIVE AUDIO ──► Node.js ──► Gemini Live ──► Node.js ──► Caller   (real-time, streamed)
     └── RECORDING ──► WAV (MixMonitor) ──► after hangup ──► POST /api/recordings ──► Node.js
```

## Features

- **PJSIP** registration/authentication against a SIP provider (not chan_sip)
- Incoming calls answered via Asterisk ARI `ExternalMedia` → Node.js RTP
- **One Gemini Live session per call** (never shared across calls)
- Continuous bidirectional audio: caller speech in, AI speech out, as it streams
- **Barge-in**: caller can interrupt the AI mid-sentence (queued audio is flushed)
- **Call recording** via `MixMonitor` to WAV, uploaded asynchronously after hangup
- `GET /health` and authenticated `POST /api/recordings` HTTP endpoints
- Structured JSON logs (`CALL_INCOMING`, `MEDIA_CONNECTED`, `GEMINI_CONNECTED`, `AI_INTERRUPTED`, `RECORDING_UPLOADED`, …) with `call_id`
- systemd service with auto-restart; Asterisk enabled on boot

## Audio format contract

Everything on the phone/RTP side stays at the telephone narrowband format the call actually uses.

| Path | Codec / format |
|---|---|
| SIP / RTP between Asterisk and provider | `ulaw` (G.711u), 8 kHz, 20 ms = 160 bytes/frame |
| Asterisk `ExternalMedia` | `ulaw` over UDP RTP, 160-byte payloads at exactly 20 ms cadence |
| Node → Gemini Live input | PCM16 `audio/pcm;rate=16000`, base64 via `sendRealtimeInput` |
| Gemini Live output | PCM16 24 kHz → resampled to 8 kHz → `ulaw` 160-byte frames |
| Output pacing | Single steady 20 ms ticker queue (verified: 160-byte frames, 18–21 ms gaps) |

No unnecessary conversions. Gemini keeps high-fidelity audio internally; only the final hop is converted down to what the phone call needs. `ulaw` 8 kHz is what the provider negotiates, so that is what is sent to Asterisk.

## Repository layout

```
src/server.js            ARI client, Stasis app handler, session registry
src/media-session.js     Per-call session: RTP socket, outbound ticker, VAD/barge-in, TTS fallback
src/gemini-live.js       Gemini Live session wrapper (one per call)
src/recording-server.js  Express app: GET /health, authenticated POST /api/recordings
src/rtp.js               UDP RTP socket with 160-byte ulaw framing
src/codecs.js            ulaw<->PCM16 + linear resampler
src/config.js            Env-driven config (dotenv)
src/logger.js            Structured JSON logging
asterisk/pjsip.conf      PJSIP transport, provider registration/auth, endpoint, identify
asterisk/extensions.conf Incoming dialplan: call id, Answer, MixMonitor, Stasis, upload hook
asterisk/rtp.conf        RTP port range
asterisk/ari.conf        ARI user
asterisk/http.conf       ARI HTTP (localhost:8088)
systemd/gemini-bridge.service
scripts/upload-recording.sh   After-call recording uploader (curl POST)
assets/greeting.ulaw     Pre-generated greeting (Gemini neural TTS, ulaw 8k)
deploy.sh                One-shot Ubuntu installer (prompts for secrets)
```

## Prerequisites

- Ubuntu 22.04 / 24.04 (LTS) server (Asterisk 18+, Node.js 18+)
- A SIP provider account (username, password, server IP/host) and inbound DID
- A Gemini API key with the **Live API** enabled for the selected model

## Installation

### Quick deploy (one-shot, recommended)

```bash
git clone https://github.com/kamranraz28/ai-call-asterisk.git
cd ai-call-asterisk
sudo bash deploy.sh          # prompts for Gemini key, SIP creds, external IP
```

`deploy.sh` installs Asterisk + Node/npm, writes `/etc/asterisk/*.conf`, creates `/opt/gemini-bridge/.env` (mode 600), installs the systemd service, opens firewall ports, and starts everything.

### Manual install

```bash
cp .env.example .env
nano .env                    # fill GEMINI_API_KEY, SIP_USERNAME, SIP_PASSWORD, etc.
npm install
sudo apt install -y asterisk sox curl

# copy Asterisk configs (or let deploy.sh do it)
sudo cp asterisk/pjsip.conf /etc/asterisk/
sudo cp asterisk/extensions.conf /etc/asterisk/
sudo cp asterisk/rtp.conf /etc/asterisk/
sudo cp asterisk/ari.conf /etc/asterisk/
sudo cp asterisk/http.conf /etc/asterisk/
sudo systemctl enable --now asterisk

# systemd service for the bridge
sudo cp systemd/gemini-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gemini-bridge
```

> In the manual flow, set the SIP credentials in `pjsip.conf` yourself (or edit via the values in `.env`). The repo ships placeholders only; `.env` is git-ignored.

## Environment variables (`.env` / `.env.example`)

```
SIP_USERNAME=
SIP_PASSWORD=
SIP_SERVER=
SIP_EXTERNAL_IP=          # public IP if behind NAT / for external media
ARI_URL=http://127.0.0.1:8088
ARI_USER=ari_user
ARI_PASSWORD=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-live-preview
GEMINI_LIVE_ENDPOINT=
NODE_HOST=0.0.0.0
NODE_MEDIA_HOST=127.0.0.1
NODE_MEDIA_PORT=4000
NODE_HTTP_PORT=5410
RECORDING_DIR=./recordings
RECORDING_UPLOAD_TOKEN=
STASIS_APP=gemini-live
```

Secrets (`SIP_PASSWORD`, `GEMINI_API_KEY`, `ARI_PASSWORD`, `RECORDING_UPLOAD_TOKEN`) are never committed, never logged.

## Node.js HTTP API

- `GET /health` → `{ "status": "ok", "activeCalls": 0, "uptime": 123.4 }`
- `POST /api/recordings` — authenticated with `Authorization: Bearer <RECORDING_UPLOAD_TOKEN>`, accepts `multipart/form-data`:

  | field | description |
  |---|---|
  | `call_id` | Asterisk call id (also in logs + filename) |
  | `caller` | caller number |
  | `destination` | dialed number |
  | `started_at` / `ended_at` / `duration` | call metadata |
  | `recording` | the WAV file |

Records are stored as `recordings/YYYY-MM-DD/call-<call_id>.wav`.

## Firewall

| Port / range | Protocol | Reachable from | Purpose |
|---|---|---|---|
| 5060 | UDP | SIP provider | SIP signalling |
| 10000–10100 | UDP | SIP provider | RTP media |
| 8088 | TCP | localhost only | ARI HTTP/WebSocket |
| 4000 | UDP | localhost (Asterisk↔Node) | ExternalMedia RTP |
| 5410 | TCP | your admin network | `/health`, recording upload |

`deploy.sh` opens what is needed with `ufw`; `8088` stays bound to `127.0.0.1`.

## Verifying it runs

```bash
asterisk -rx "pjsip show registrations"     # → Registered
curl http://127.0.0.1:5410/health           # → {"status":"ok",...}
journalctl -u gemini-bridge -f              # live structured logs
```

Place a call to your DID and watch the log stream:

`CALL_INCOMING → CALL_ANSWERED → MEDIA_CONNECTED → GEMINI_CONNECTED → (CALLER_AUDIO ↔ GEMINI_AUDIO) → CALL_ENDED → RECORDING_UPLOADED`

Verify real-time streaming: `GEMINI_CONNECTED` → `GEMINI_AUDIO` shows `latency_since_connect` (first audio), and outgoing frames are sent as 160-byte ulaw payloads on a steady ~20 ms cadence (`GEMINI_AUDIO_SENT`). You should hear the AI begin speaking before it finishes responding — never after a full recorded silence buffer.

## Recording flow (independent of AI)

1. Dialplan `Answer()`, assigns `CALL_ID`, then `MixMonitor(/var/spool/asterisk/recordings/${CALL_ID}.wav)`.
2. Call enters `Stasis(gemini-live)` and Node bridges the live audio.
3. On hangup, `StopMixMonitor()` finalizes the WAV.
4. `scripts/upload-recording.sh` posts the WAV to `POST /api/recordings` with retries — asynchronously, without delaying call teardown.
5. Node stores it under `recordings/<date>/`.

The live media path never touches the WAV.

## Security notes

- `.env` and `recordings/` are git-ignored
- Recording endpoint requires a bearer token
- ARI binds to `127.0.0.1` and uses a random password from `deploy.sh`
- No SIP password, API keys, or auth tokens are written to logs