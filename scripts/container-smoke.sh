#!/usr/bin/env bash
set -euo pipefail
network="sculpin-hub-local_default"
database_url="postgresql://sculpin:local-development-only@postgres:5432/sculpin_hub"
cleanup(){ docker rm -f sculpin-web-smoke sculpin-proxy-smoke sculpin-worker-smoke >/dev/null 2>&1 || true; }
trap cleanup EXIT
for image in sculpin-hub-web sculpin-hub-proxy sculpin-hub-worker; do
  user="$(docker image inspect --format '{{.Config.User}}' "$image")"
  if [[ -z "$user" || "$user" == "0" || "$user" == "root" ]]; then echo "$image does not configure a non-root runtime user" >&2; exit 1; fi
  echo "$image runtime user: $user"
done
docker run -d --name sculpin-web-smoke --network "$network" -p 127.0.0.1:3000:3000 -e NODE_ENV=test -e DATABASE_URL="$database_url" sculpin-hub-web >/dev/null
docker run -d --name sculpin-proxy-smoke --network "$network" -p 127.0.0.1:3001:3001 -e NODE_ENV=test -e DATABASE_URL="$database_url" -e PROXY_HOST=0.0.0.0 sculpin-hub-proxy >/dev/null
for url in http://127.0.0.1:3000/api/health/live http://127.0.0.1:3000/api/health/ready http://127.0.0.1:3001/health/live http://127.0.0.1:3001/health/ready; do
  for attempt in {1..30}; do if curl --fail --silent "$url" >/dev/null; then break; fi; sleep 1; done
  curl --fail --silent --show-error "$url" >/dev/null
  echo "healthy: $url"
done
docker run -d --name sculpin-worker-smoke --network "$network" -e NODE_ENV=test -e DATABASE_URL="$database_url" sculpin-hub-worker >/dev/null
for attempt in {1..15}; do docker logs sculpin-worker-smoke 2>&1 | grep -q "worker is idle" && break; sleep 1; done
docker logs sculpin-worker-smoke 2>&1 | grep -q "worker is idle"
docker stop --time 15 sculpin-worker-smoke >/dev/null
[[ "$(docker inspect --format '{{.State.ExitCode}}' sculpin-worker-smoke)" == "0" ]]
echo "worker idle state and bounded SIGTERM shutdown verified"
