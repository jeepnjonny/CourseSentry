#!/usr/bin/env bash
# CourseSentry — first-time server setup
# Run as a user with sudo access on coursesentry.k7swi.org
# Usage: bash setup.sh [--ssl]

set -euo pipefail

INSTALL_DIR="/srv/CourseSentry"
SERVICE_USER="www-data"
NODE_MIN="18"
HOSTNAME="coursesentry.k7swi.org"
CERTBOT_EMAIL="kg7kmv@gmail.com"
SSL=${1:-""}

echo "=== CourseSentry Setup ==="

# ── Node.js ────────────────────────────────────────────────────────────────
NODE_VER=0
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
fi

if [ "$NODE_VER" -lt "$NODE_MIN" ]; then
  echo "Installing Node.js 20 via NodeSource (found v${NODE_VER})..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "  Node.js $(node --version) OK"

# ── Deploy files ───────────────────────────────────────────────────────────
sudo mkdir -p "${INSTALL_DIR}"
sudo rsync -av --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  "$(dirname "$(realpath "$0")")/" "${INSTALL_DIR}/"

sudo mkdir -p "${INSTALL_DIR}/data/uploads/tracks" \
             "${INSTALL_DIR}/data/uploads/participants"
sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# ── npm dependencies ───────────────────────────────────────────────────────
echo "Installing npm dependencies..."
cd "${INSTALL_DIR}"
sudo -u "${SERVICE_USER}" npm install --omit=dev
echo "  npm OK"

# ── Systemd service ────────────────────────────────────────────────────────
sudo tee /etc/systemd/system/coursesentry.service > /dev/null <<EOF
[Unit]
Description=CourseSentry Node.js server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=3000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable coursesentry
sudo systemctl restart coursesentry
echo "  coursesentry service started"

# ── nginx ──────────────────────────────────────────────────────────────────
NGINX_AVAILABLE=/etc/nginx/sites-available/coursesentry
NGINX_ENABLED=/etc/nginx/sites-enabled/coursesentry

# Temporary HTTP-only block used before certs exist
HTTP_ONLY_CONF="server {
    listen 80;
    listen [::]:80;
    server_name ${HOSTNAME};
    location / {
        proxy_pass         http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        client_max_body_size 50m;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}"

if [ ! -d /etc/nginx/sites-available ]; then
  echo "  nginx sites-available not found — copy nginx-coursesentry.conf manually."
else
  if [ "${SSL}" = "--ssl" ]; then
    # ── Phase 1: deploy HTTP-only so certbot can validate the domain ──────
    echo "  nginx: deploying temporary HTTP config for cert validation..."
    echo "${HTTP_ONLY_CONF}" | sudo tee "${NGINX_AVAILABLE}" > /dev/null
    sudo ln -sf "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
    sudo nginx -t && sudo systemctl reload nginx

    # ── Phase 2: obtain cert (certonly — does not modify nginx config) ────
    echo "  certbot: requesting certificate..."
    if ! command -v certbot &>/dev/null; then
      sudo apt-get install -y certbot python3-certbot-nginx
    fi
    sudo certbot certonly --nginx \
      -d "${HOSTNAME}" \
      --non-interactive --agree-tos -m "${CERTBOT_EMAIL}"

    # ── Phase 3: deploy full SSL config now that certs exist ──────────────
    echo "  nginx: deploying full SSL config..."
    sudo cp "${INSTALL_DIR}/nginx-coursesentry.conf" "${NGINX_AVAILABLE}"
    sudo nginx -t && sudo systemctl reload nginx
    echo "  SSL configured — https://${HOSTNAME}/"
  else
    # No SSL yet — deploy HTTP-only config
    echo "  nginx: deploying HTTP config (run with --ssl to enable HTTPS)..."
    echo "${HTTP_ONLY_CONF}" | sudo tee "${NGINX_AVAILABLE}" > /dev/null
    sudo ln -sf "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
    sudo nginx -t && sudo systemctl reload nginx
    echo "  nginx configured"
  fi
fi

if [ "${SSL}" != "--ssl" ]; then
  echo ""
  echo "  TIP: Re-run with --ssl to configure HTTPS via certbot:"
  echo "       bash setup.sh --ssl"
fi

echo ""
echo "=== Setup complete ==="
echo "  App:    $([ "${SSL}" = "--ssl" ] && echo "https" || echo "http")://${HOSTNAME}/"
echo "  Status: sudo systemctl status coursesentry"
echo "  Logs:   sudo journalctl -u coursesentry -f"
