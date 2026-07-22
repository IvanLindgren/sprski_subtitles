#!/usr/bin/env bash
set -euo pipefail

readonly APP_DIR="/opt/serbiansubtitles"
readonly APP_USER="serbiansubtitles"
readonly NODE_VERSION="22.16.0"
readonly NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils git certbot python3-certbot-nginx

if [[ ! -x "/opt/node-v${NODE_VERSION}-linux-x64/bin/node" ]]; then
  download_dir="$(mktemp -d)"
  trap 'rm -rf "$download_dir"' EXIT
  cd "$download_dir"
  curl --fail --silent --show-error --location --remote-name "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
  curl --fail --silent --show-error --location --remote-name "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  grep " ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum --check --strict
  tar -xJf "$NODE_ARCHIVE" -C /opt
fi

for executable in node npm npx corepack; do
  ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64/bin/${executable}" "/usr/local/bin/${executable}"
done

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  git clone --branch main --single-branch https://github.com/IvanLindgren/sprski_subtitles.git "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" checkout main
  git -C "$APP_DIR" pull --ff-only origin main
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
runuser -u "$APP_USER" -- env PATH=/usr/local/bin:/usr/bin:/bin npm --prefix "$APP_DIR" ci
runuser -u "$APP_USER" -- env PATH=/usr/local/bin:/usr/bin:/bin npm --prefix "$APP_DIR" run build

node --version
npm --version
