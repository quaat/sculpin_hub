#!/usr/bin/env bash
set -euo pipefail
network="sculpin-hub-local_default"
password="${POSTGRES_PASSWORD:-local-development-only}"
mode="${SMOKE_NODE_ENV:-test}"
database_url="postgresql://sculpin:${password}@postgres:5432/sculpin_hub"
containers=(sculpin-web-smoke sculpin-proxy-smoke sculpin-worker-smoke)
cleanup(){ code=$?; if (( code != 0 )); then for name in "${containers[@]}"; do docker logs "$name" 2>&1 | sed -E 's#postgresql://[^ ]+#postgresql://[redacted]#g' || true; done; fi; docker rm -f "${containers[@]}" >/dev/null 2>&1 || true; exit "$code"; }
trap cleanup EXIT
probe(){ curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$@"; }
wait_for(){ local url=$1; for _ in {1..30}; do probe "$url" >/dev/null && return; sleep 1; done; probe "$url" >/dev/null; }
for image in sculpin-hub-web sculpin-hub-proxy sculpin-hub-worker; do user="$(docker image inspect --format '{{.Config.User}}' "$image")"; [[ -n "$user" && "$user" != 0 && "$user" != root ]] || { echo "$image does not configure a non-root user" >&2; exit 1; }; done
docker run -d --name sculpin-web-smoke --network "$network" -p 127.0.0.1:3000:3000 -e NODE_ENV="$mode" -e DATABASE_URL="$database_url" sculpin-hub-web >/dev/null
docker run -d --name sculpin-proxy-smoke --network "$network" -p 127.0.0.1:3001:3001 -e NODE_ENV="$mode" -e DATABASE_URL="$database_url" -e PROXY_HOST=0.0.0.0 sculpin-hub-proxy >/dev/null
for url in http://127.0.0.1:3000/api/health/live http://127.0.0.1:3000/api/health/ready http://127.0.0.1:3001/health/live http://127.0.0.1:3001/health/ready; do wait_for "$url"; done
headers="$(probe -D - -o /dev/null http://127.0.0.1:3000/)"; grep -qi '^x-content-type-options: nosniff' <<<"$headers"; grep -qi '^referrer-policy: strict-origin-when-cross-origin' <<<"$headers"; grep -qi '^content-security-policy:.*frame-ancestors' <<<"$headers"
for path in /v1 /v1/ /v1/nested/example; do body="$(curl --silent --show-error --connect-timeout 2 --max-time 5 -w $'\n%{http_code}' "http://127.0.0.1:3001$path")"; [[ "${body##*$'\n'}" == 404 ]]; grep -q '"code":"unsupported_operation"' <<<"${body%$'\n'*}"; done
docker run -d --name sculpin-worker-smoke --network "$network" -e NODE_ENV="$mode" -e DATABASE_URL="$database_url" sculpin-hub-worker >/dev/null
for _ in {1..15}; do docker logs sculpin-worker-smoke 2>&1 | grep -q "worker is idle" && break; sleep 1; done
docker logs sculpin-worker-smoke 2>&1 | grep -q "worker is idle"
docker stop --time 15 sculpin-worker-smoke >/dev/null; [[ "$(docker inspect --format '{{.State.ExitCode}}' sculpin-worker-smoke)" == 0 ]]
docker stop --time 15 sculpin-proxy-smoke >/dev/null; [[ "$(docker inspect --format '{{.State.ExitCode}}' sculpin-proxy-smoke)" == 0 ]]
echo "container health, security, routing, ownership, and shutdown checks passed"
