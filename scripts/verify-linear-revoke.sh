#!/usr/bin/env bash
# Run ONCE before enabling the gate in production. It checks that revoking one
# client_credentials token of the Linear app does NOT revoke the app's other
# tokens (the agent's token must survive the gate's per-check revoke).
#
#   LINEAR_CLIENT_ID=... LINEAR_CLIENT_SECRET=... ./scripts/verify-linear-revoke.sh
#
# Uses the same scopes as linear-app-actor.sh. Prints only HTTP status codes,
# never a token. Both test tokens are revoked at the end.
set -euo pipefail
: "${LINEAR_CLIENT_ID:?set LINEAR_CLIENT_ID}" "${LINEAR_CLIENT_SECRET:?set LINEAR_CLIENT_SECRET}"
SCOPE="read write app:mentionable"

mint() {
  curl -sS -u "$LINEAR_CLIENT_ID:$LINEAR_CLIENT_SECRET" -X POST https://api.linear.app/oauth/token \
    --data-urlencode grant_type=client_credentials --data-urlencode "scope=$SCOPE" |
    python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
}
viewer_status() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST https://api.linear.app/graphql \
    -H "Authorization: Bearer $1" -H 'Content-Type: application/json' --data '{"query":"{ viewer { id } }"}'
}
revoke_status() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST https://api.linear.app/oauth/revoke \
    --data-urlencode "token=$1" --data-urlencode token_type_hint=access_token
}

A=$(mint); B=$(mint)
echo "A viewer before revoke: $(viewer_status "$A")   (expect 200)"
echo "B viewer before revoke: $(viewer_status "$B")   (expect 200)"
echo "revoke A:               $(revoke_status "$A")   (expect 200)"
echo "A viewer after revoke:  $(viewer_status "$A")   (expect 401: revoke works)"
B_AFTER=$(viewer_status "$B")
echo "B viewer after revoke:  $B_AFTER   (expect 200: other tokens survive)"
echo "revoke B (cleanup):     $(revoke_status "$B")"
if [ "$B_AFTER" = "200" ]; then
  echo "OK: per-check revoke is safe for the agent's token."
else
  echo "STOP: revoking one token affected another. Do not enable the gate; the revoke must be removed first."
  exit 1
fi
