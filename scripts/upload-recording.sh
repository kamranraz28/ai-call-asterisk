#!/bin/bash
set -e
CALL_ID="$1"
CALLER="$2"
DEST="$3"
FILE="$4"
: "${NODE_HTTP_PORT:=5410}"
: "${RECORDING_UPLOAD_TOKEN:=change_me}"
URL="http://127.0.0.1:${NODE_HTTP_PORT}/api/recordings"

if [ ! -f "$FILE" ]; then echo "recording not found $FILE"; exit 0; fi

STARTED=$(stat -c %y "$FILE" 2>/dev/null || stat -f %Sm "$FILE" 2>/dev/null || echo "")
ENDED=$(date -Iseconds)
DURATION=$(soxi -D "$FILE" 2>/dev/null || echo "")

for i in 1 2 3; do
  if curl -fsS -X POST "$URL" \
    -H "Authorization: Bearer ${RECORDING_UPLOAD_TOKEN}" \
    -F "call_id=${CALL_ID}" \
    -F "caller=${CALLER}" \
    -F "destination=${DEST}" \
    -F "started_at=${STARTED}" \
    -F "ended_at=${ENDED}" \
    -F "duration=${DURATION}" \
    -F "recording=@${FILE}"; then
    echo "RECORDING_UPLOADED $CALL_ID"
    exit 0
  fi
  sleep $((i*2))
done
echo "RECORDING_UPLOAD_FAILED $CALL_ID keep local $FILE" >&2
exit 0
