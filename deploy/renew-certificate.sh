#!/bin/sh
set -eu

: "${SHARED_SERVICE_ROOT:?Set the private service state directory}"
: "${SHARED_CERTIFICATES_ROOT:?Set the private gateway certificates directory}"
: "${SHARED_DOMAIN:?Set the certificate domain}"
: "${SHARED_GATEWAY_CONTAINER:?Set the gateway container name}"
: "${SHARED_GATEWAY_HEALTH_DOMAIN:?Set a gateway HTTPS health-check domain}"
state="$SHARED_SERVICE_ROOT"
certificates="$SHARED_CERTIFICATES_ROOT"
source="$state/acme/live/$SHARED_DOMAIN"
target="$certificates/shared-session"
gateway_gid="${SHARED_GATEWAY_GID:-101}"

docker run --rm \
  -v "$state/acme:/etc/letsencrypt" \
  -v "$certificates/shared-session-acme:/var/www/acme" \
  certbot/certbot renew --quiet --no-random-sleep-on-renew

if cmp -s "$source/fullchain.pem" "$target/fullchain.pem" && cmp -s "$source/privkey.pem" "$target/privkey.pem"; then
  exit 0
fi

install -d -m 700 "$state/backups"
install -d -m 750 -o 0 -g "$gateway_gid" "$target"
backup=$(mktemp -d "$state/backups/certificate-XXXXXXXX")
if [ -f "$target/fullchain.pem" ]; then
  cp -p "$target/fullchain.pem" "$backup/fullchain.pem"
  cp -p "$target/privkey.pem" "$backup/privkey.pem"
fi
install -m 640 -o 0 -g "$gateway_gid" "$source/fullchain.pem" "$target/fullchain.pem.new"
install -m 640 -o 0 -g "$gateway_gid" "$source/privkey.pem" "$target/privkey.pem.new"
mv "$target/fullchain.pem.new" "$target/fullchain.pem"
mv "$target/privkey.pem.new" "$target/privkey.pem"

restore() {
  if [ -f "$backup/fullchain.pem" ]; then
    cp -p "$backup/fullchain.pem" "$target/fullchain.pem"
    cp -p "$backup/privkey.pem" "$target/privkey.pem"
    docker exec "$SHARED_GATEWAY_CONTAINER" nginx -t
    docker exec "$SHARED_GATEWAY_CONTAINER" nginx -s reload
  fi
}
if ! docker exec "$SHARED_GATEWAY_CONTAINER" nginx -t; then
  restore
  exit 1
fi
if ! docker exec "$SHARED_GATEWAY_CONTAINER" nginx -s reload; then
  restore
  exit 1
fi
if ! curl --fail --silent --show-error --max-time 15 --resolve "$SHARED_GATEWAY_HEALTH_DOMAIN:443:127.0.0.1" "https://$SHARED_GATEWAY_HEALTH_DOMAIN/healthz" >/dev/null; then
  restore
  exit 1
fi
