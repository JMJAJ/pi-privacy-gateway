#!/bin/bash
# Prepare a Linux host (Raspberry Pi OS, Ubuntu, Debian, ...) for Pi Privacy Gateway.
# Safe to re-run. Usage:  sudo ./scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mnote\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31mfail\033[0m  %s\n' "$*"; exit 1; }
ask()  { local a; read -r -p "  $1 [y/N] " a; [[ $a =~ ^[Yy] ]]; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ "$(uname -s)" = Linux ] || die "Linux only"

echo "Checking the host..."

# 1. WireGuard in the kernel (Linux 5.6+ has it built in)
if modprobe wireguard 2>/dev/null || ip link add pgw-test type wireguard 2>/dev/null; then
  ip link del pgw-test 2>/dev/null || true; ok "kernel WireGuard support"
else
  die "this kernel has no WireGuard support (needs Linux 5.6+)"
fi

# 2. Docker + compose
if ! command -v docker >/dev/null; then
  warn "Docker is not installed"
  ask "Install Docker now with the official script (get.docker.com)?" || die "install Docker, then re-run"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "the 'docker compose' plugin is missing"
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

# 3. Port 53 must be free for AdGuard (Ubuntu's systemd-resolved stub listens on 127.0.0.53:53)
if ss -lntu | grep -qE '127\.0\.0\.5[34]:53 '; then
  warn "systemd-resolved's DNS stub is using port 53"
  if ask "Disable the stub listener (the host keeps working DNS)?"; then
    mkdir -p /etc/systemd/resolved.conf.d
    printf '[Resolve]\nDNSStubListener=no\n' > /etc/systemd/resolved.conf.d/pgw.conf
    ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
    systemctl restart systemd-resolved
    ok "port 53 freed"
  else
    die "AdGuard needs port 53"
  fi
elif ss -lntu | grep -qE ':53 ' && ! docker ps --format '{{.Names}}' | grep -q pgw-adguard; then
  warn "something else already listens on port 53: $(ss -lntup | awk '/:53 /{print $7}' | head -1)"
else
  ok "port 53 is free"
fi

# 4. Clock: Tor refuses to work with a wrong clock, and a Pi has no battery-backed clock
if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then ok "clock is synchronised"
else warn "clock not synchronised yet - make sure NTP works (timedatectl), Tor depends on it"; fi

# 5. .env with a random placeholder password
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^ADGUARD_PASSWORD=.*/ADGUARD_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')/" .env
  chmod 600 .env
  ok ".env created - use the ADGUARD_PASSWORD in it when you run AdGuard's setup wizard"
else
  ok ".env exists"
fi
mkdir -p data/gateway data/wireguard data/adguard && chmod 700 data/gateway data/wireguard

cat <<EOF

Next:
  1. docker compose up -d --build
  2. open http://$(hostname -I | awk '{print $1}'):3000 and finish AdGuard's wizard
     (admin web interface on port 3000, DNS on port 53, login from .env)
  3. docker compose exec gateway pgw add-peer phone      # scan the QR with the WireGuard app
  4. dashboard: http://10.13.13.1/dashboard (through the VPN) or http://$(hostname -I | awk '{print $1}')/dashboard
EOF
