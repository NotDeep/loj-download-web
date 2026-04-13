#!/usr/bin/env bash

set -euo pipefail

SERVER_HOST="${SERVER_HOST:-198.46.253.4}"
SERVER_USER="${SERVER_USER:-root}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
APP_PORT="${APP_PORT:-18730}"
REMOTE_DIR="${REMOTE_DIR:-/srv/loj-download-web}"
LOJ_BASE_URL="${LOJ_BASE_URL:-https://loj.ac}"
APP_BASE_PATH="${APP_BASE_PATH:-}"
CONFIGURE_NGINX="${CONFIGURE_NGINX:-1}"

print_usage() {
  cat <<'EOF'
Usage:
  bash deploy/deploy-via-password.sh [options] [server_host]

Options:
  --host <ip-or-domain>       Target server IP or domain
  --user <user>               SSH user, default: root
  --public-host <ip-domain>   Public address shown after deployment, default: same as host
  --port <port>               Internal app port, default: 18730
  --remote-dir <path>         Remote project directory, default: /srv/loj-download-web
  --loj-base-url <url>        Target LibreOJ site, default: https://loj.ac
  --base-path <path>          Mount path such as /loj-download
  --skip-nginx                Do not modify nginx; only deploy the app service
  -h, --help                  Show this help message

Examples:
  bash deploy/deploy-via-password.sh
  bash deploy/deploy-via-password.sh 43.167.213.211
  bash deploy/deploy-via-password.sh --host 43.167.213.211 --port 18730
  bash deploy/deploy-via-password.sh --host 43.167.213.211 --base-path /loj-download --skip-nginx
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      SERVER_HOST="$2"
      shift 2
      ;;
    --user)
      SERVER_USER="$2"
      shift 2
      ;;
    --public-host)
      PUBLIC_HOST="$2"
      shift 2
      ;;
    --port)
      APP_PORT="$2"
      shift 2
      ;;
    --remote-dir)
      REMOTE_DIR="$2"
      shift 2
      ;;
    --loj-base-url)
      LOJ_BASE_URL="$2"
      shift 2
      ;;
    --base-path)
      APP_BASE_PATH="$2"
      shift 2
      ;;
    --skip-nginx)
      CONFIGURE_NGINX="0"
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      print_usage >&2
      exit 1
      ;;
    *)
      SERVER_HOST="$1"
      shift
      ;;
  esac
done

if [[ -z "${PUBLIC_HOST}" ]]; then
  PUBLIC_HOST="${SERVER_HOST}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REMOTE_HOST="${SERVER_USER}@${SERVER_HOST}"
WORK_DIR="$(mktemp -d)"
LOCAL_ARCHIVE="${WORK_DIR}/loj-download-web.tar.gz"
LOCAL_REMOTE_SCRIPT="${WORK_DIR}/loj-download-web-remote-setup.sh"
REMOTE_ARCHIVE="/tmp/loj-download-web.tar.gz"
REMOTE_SCRIPT="/tmp/loj-download-web-remote-setup.sh"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

run_expect_cmd() {
  local command="$1"
  EXPECT_PASSWORD="${SSH_PASSWORD}" EXPECT_COMMAND="${command}" /usr/bin/expect <<'EOF'
set timeout -1
log_user 1
set password $env(EXPECT_PASSWORD)
set command $env(EXPECT_COMMAND)
spawn -noecho /bin/sh -lc $command
expect {
  -re {\(yes/no\)\?} {
    send -- "yes\r"
    exp_continue
  }
  -re {(?i)password:} {
    send -- "$password\r"
    exp_continue
  }
  -re {Permission denied} {
    puts stderr "Authentication failed. Please verify the password and whether root password login is allowed on the server."
    exit 1
  }
  eof {
    catch wait result
    set status [lindex $result 3]
    exit $status
  }
}
EOF
}

require_command expect
require_command tar
require_command ssh
require_command scp

if [[ ! -f "${PROJECT_DIR}/package.json" ]]; then
  echo "Cannot find package.json under ${PROJECT_DIR}" >&2
  exit 1
fi

printf 'Deploy target: %s\n' "${REMOTE_HOST}"
printf 'Public URL after deployment: http://%s/\n' "${PUBLIC_HOST}"
printf 'Internal app port: %s\n' "${APP_PORT}"
printf 'Remote directory: %s\n' "${REMOTE_DIR}"
printf 'App base path: %s\n' "${APP_BASE_PATH:-/}"
printf 'Configure nginx: %s\n' "${CONFIGURE_NGINX}"
printf '\n'
read -r -s -p "Password for ${REMOTE_HOST}: " SSH_PASSWORD
printf '\n'

if [[ -z "${SSH_PASSWORD}" ]]; then
  echo "Password cannot be empty." >&2
  exit 1
fi

cat > "${LOCAL_REMOTE_SCRIPT}" <<EOF
#!/usr/bin/env bash

set -euo pipefail

APP_PORT="${APP_PORT}"
PUBLIC_HOST="${PUBLIC_HOST}"
REMOTE_DIR="${REMOTE_DIR}"
REMOTE_ARCHIVE="${REMOTE_ARCHIVE}"
LOJ_BASE_URL="${LOJ_BASE_URL}"
APP_BASE_PATH="${APP_BASE_PATH}"
CONFIGURE_NGINX="${CONFIGURE_NGINX}"

install_node_and_nginx() {
  local current_major="0"
  local platform_family=""
  if command -v node >/dev/null 2>&1; then
    current_major="\$(node -v | sed 's/^v//' | cut -d. -f1)"
  fi

  detect_platform_family() {
    local ids=""
    if [[ -r /etc/os-release ]]; then
      . /etc/os-release
      ids="\${ID:-} \${ID_LIKE:-}"
    fi

    case " \${ids} " in
      *" debian "*|*" ubuntu "*)
        echo "deb"
        return 0
        ;;
      *" rhel "*|*" fedora "*|*" centos "*|*" rocky "*|*" almalinux "*|*" ol "*|*" anolis "*|*" opencloudos "*|*" cloudlinux "*|*" amzn "*)
        echo "rpm"
        return 0
        ;;
    esac

    if command -v apt-get >/dev/null 2>&1; then
      echo "deb"
    elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
      echo "rpm"
    else
      echo "unknown"
    fi
  }

  install_node_binary() {
    local arch=""
    local node_arch=""
    local node_version="v20.20.1"
    local node_dir=""
    local download_url=""
    local tmp_dir=""

    arch="\$(uname -m)"
    case "\${arch}" in
      x86_64|amd64)
        node_arch="x64"
        ;;
      aarch64|arm64)
        node_arch="arm64"
        ;;
      armv7l)
        node_arch="armv7l"
        ;;
      *)
        echo "Unsupported architecture for automatic Node.js install: \${arch}" >&2
        exit 1
        ;;
    esac

    if command -v apt-get >/dev/null 2>&1; then
      apt-get install -y xz-utils
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y xz
    elif command -v yum >/dev/null 2>&1; then
      yum install -y xz
    fi

    tmp_dir="\$(mktemp -d)"
    download_url="https://nodejs.org/dist/\${node_version}/node-\${node_version}-linux-\${node_arch}.tar.xz"
    curl -fsSL "\${download_url}" -o "\${tmp_dir}/node.tar.xz"
    mkdir -p /usr/local/lib/nodejs
    tar -xJf "\${tmp_dir}/node.tar.xz" -C /usr/local/lib/nodejs
    node_dir="/usr/local/lib/nodejs/node-\${node_version}-linux-\${node_arch}"
    ln -sf "\${node_dir}/bin/node" /usr/local/bin/node
    ln -sf "\${node_dir}/bin/npm" /usr/local/bin/npm
    ln -sf "\${node_dir}/bin/npx" /usr/local/bin/npx
    ln -sf "\${node_dir}/bin/corepack" /usr/local/bin/corepack
    rm -rf "\${tmp_dir}"
  }

  platform_family="\$(detect_platform_family)"

  if [[ "\${current_major}" -lt 20 ]]; then
    case "\${platform_family}" in
      deb)
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y curl ca-certificates gnupg nginx
        if curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; then
          apt-get install -y nodejs
        else
          echo "NodeSource deb installer failed, falling back to the official Node.js binary." >&2
          install_node_binary
        fi
        ;;
      rpm)
        if command -v dnf >/dev/null 2>&1; then
          dnf install -y curl ca-certificates gnupg2 nginx
          if curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -; then
            dnf install -y nodejs
          else
            echo "NodeSource rpm installer failed, falling back to the official Node.js binary." >&2
            install_node_binary
          fi
        elif command -v yum >/dev/null 2>&1; then
          yum install -y curl ca-certificates nginx
          if curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -; then
            yum install -y nodejs
          else
            echo "NodeSource rpm installer failed, falling back to the official Node.js binary." >&2
            install_node_binary
          fi
        else
          install_node_binary
        fi
        ;;
      *)
        echo "Unknown Linux family, installing Node.js from the official binary." >&2
        install_node_binary
        ;;
    esac
  else
    case "\${platform_family}" in
      deb)
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y nginx
        ;;
      rpm)
        if command -v dnf >/dev/null 2>&1; then
          dnf install -y nginx
        elif command -v yum >/dev/null 2>&1; then
          yum install -y nginx
        fi
        ;;
    esac
  fi
}

try_install_nginx_stream_module() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y libnginx-mod-stream || return 1
    return 0
  fi

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y nginx-mod-stream || return 1
    return 0
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y nginx-mod-stream || return 1
    return 0
  fi

  return 1
}

configure_nginx() {
  local nginx_output=""
  if ! command -v nginx >/dev/null 2>&1; then
    echo "Nginx is not installed. The web app will continue to run directly on port \${APP_PORT}." >&2
    return 1
  fi
  if nginx_output="\$(nginx -t 2>&1)"; then
    echo "\${nginx_output}"
    systemctl enable nginx
    systemctl restart nginx
    echo "Nginx is active on port 80."
    return 0
  fi

  echo "\${nginx_output}" >&2
  if echo "\${nginx_output}" | grep -q 'unknown directive "stream"'; then
    echo "Trying to install nginx stream module..." >&2
    if try_install_nginx_stream_module; then
      if nginx_output="\$(nginx -t 2>&1)"; then
        echo "\${nginx_output}"
        systemctl enable nginx
        systemctl restart nginx
        echo "Nginx is active on port 80."
        return 0
      fi
      echo "\${nginx_output}" >&2
    fi
  fi

  echo "Nginx configuration is still invalid. The web app will continue to run directly on port \${APP_PORT}." >&2
  return 1
}

install_node_and_nginx
corepack enable || true
if ! command -v yarn >/dev/null 2>&1; then
  corepack prepare yarn@1.22.22 --activate
fi

mkdir -p "\${REMOTE_DIR}"
mkdir -p "\${REMOTE_DIR}/storage"
find "\${REMOTE_DIR}" -mindepth 1 -maxdepth 1 ! -name storage -exec rm -rf {} +
tar -xzf "\${REMOTE_ARCHIVE}" -C "\${REMOTE_DIR}"

cd "\${REMOTE_DIR}"
yarn install --frozen-lockfile

cat > /etc/loj-download-web.env <<ENV_FILE
PORT=\${APP_PORT}
LOJ_BASE_URL=\${LOJ_BASE_URL}
APP_BASE_PATH=\${APP_BASE_PATH}
LOJ_COOKIE=
STORAGE_DIR=\${REMOTE_DIR}/storage
JOB_CONCURRENCY=2
DOWNLOAD_CONCURRENCY=5
JOB_RETENTION_HOURS=24
ENV_FILE

cat > /etc/systemd/system/loj-download-web.service <<SYSTEMD_FILE
[Unit]
Description=LibreOJ Problem Package Downloader Web Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=\${REMOTE_DIR}
EnvironmentFile=/etc/loj-download-web.env
ExecStart=/usr/bin/env node \${REMOTE_DIR}/bin/loj-download-web.js
Restart=always
RestartSec=5
TimeoutStopSec=20
User=root
Group=root
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=\${REMOTE_DIR}/storage
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
SYSTEMD_FILE

mkdir -p /etc/nginx/conf.d
cat > /etc/nginx/conf.d/loj-download-web.conf <<NGINX_FILE
server {
    listen 80;
    server_name \${PUBLIC_HOST};

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:\${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \\\$host;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
    }
}
NGINX_FILE

systemctl daemon-reload
systemctl enable --now loj-download-web
nginx_ready=0
if [[ "\${CONFIGURE_NGINX}" = "1" ]] && configure_nginx; then
  nginx_ready=1
fi

if command -v ufw >/dev/null 2>&1; then
  if ufw status | grep -q "Status: active"; then
    if [[ "\${nginx_ready}" -eq 1 ]]; then
      ufw allow 80/tcp || true
    else
      ufw allow "\${APP_PORT}/tcp" || true
    fi
  fi
fi

if command -v firewall-cmd >/dev/null 2>&1; then
  if systemctl is-active --quiet firewalld; then
    if [[ "\${nginx_ready}" -eq 1 ]]; then
      firewall-cmd --permanent --add-service=http || true
    else
      firewall-cmd --permanent --add-port="\${APP_PORT}/tcp" || true
    fi
    firewall-cmd --reload || true
  fi
fi

sleep 2
curl -fsS "http://127.0.0.1:\${APP_PORT}\${APP_BASE_PATH}/api/health"
echo
echo "Deployment finished."
if [[ "\${nginx_ready}" -eq 1 ]]; then
  echo "Public URL: http://\${PUBLIC_HOST}\${APP_BASE_PATH}/"
else
  echo "Public URL: http://\${PUBLIC_HOST}:\${APP_PORT}\${APP_BASE_PATH}/"
  if [[ "\${CONFIGURE_NGINX}" = "1" ]]; then
    echo "Nginx was not enabled because the existing server-wide nginx configuration is invalid."
  else
    echo "Nginx changes were skipped on purpose."
  fi
fi
echo "Health URL: http://127.0.0.1:\${APP_PORT}\${APP_BASE_PATH}/api/health"
EOF

chmod +x "${LOCAL_REMOTE_SCRIPT}"

tar \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='storage' \
  --exclude='downloads' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='*.png' \
  --exclude='*.har' \
  --exclude='*.zip' \
  -czf "${LOCAL_ARCHIVE}" \
  -C "${PROJECT_DIR}" \
  .

printf '\nUploading project archive and remote setup script...\n'
run_expect_cmd "scp -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no '${LOCAL_ARCHIVE}' '${LOCAL_REMOTE_SCRIPT}' '${REMOTE_HOST}:/tmp/'"

printf '\nRunning remote deployment steps...\n'
run_expect_cmd "ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no '${REMOTE_HOST}' 'bash ${REMOTE_SCRIPT}'"

printf '\nCleaning remote temporary files...\n'
run_expect_cmd "ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no '${REMOTE_HOST}' 'rm -f ${REMOTE_ARCHIVE} ${REMOTE_SCRIPT}'"

printf '\nDeployment script finished.\n'
printf 'Open: http://%s/\n' "${PUBLIC_HOST}"
printf 'Chosen internal service port: %s\n' "${APP_PORT}"
