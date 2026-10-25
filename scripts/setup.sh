#!/bin/bash
# Prepare a Linux host (Raspberry Pi OS, Ubuntu, Debian, ...) for Pi Privacy Gateway.
# Safe to re-run. Usage:  sudo ./scripts/setup.sh [--yes]   (--yes: answer every question with yes)
set -euo pipefail
YES=0; [ "${1:-}" = --yes ] && YES=1
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mnote\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31mfail\033[0m  %s\n' "$*"; exit 1; }
ask()  { [ "$YES" = 1 ] && return 0; local a; read -r -p "  $1 [y/N] " a; [[ $a =~ ^[Yy] ]]; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ "$(uname -s)" = Linux ] || die "Linux only"

echo "Checking the host..."

# 1. WireGuard in the kernel (Linux 5.6+ has it built in)
if modprobe wireguard 2>/dev/null || ip link add pgw-test type wireguard 2>/dev/null; then
  ip link del pgw-test 2>/dev/null || true; ok "kernel WireGuard support"
else
  die "this kernel has no WireGuard support (needs Linux 5.6+)"
fi
# the gateway container is unprivileged, so the host loads the module and sets forwarding once
echo wireguard > /etc/modules-load.d/pi-privacy-gateway.conf
# threat protection: IP blocklists (ip_set) and inline inspection (NFQUEUE); optional, so no failure here
for m in ip_set ip_set_hash_net ip_set_hash_ip xt_set nfnetlink_queue xt_NFQUEUE; do
  modprobe "$m" 2>/dev/null && echo "$m" >> /etc/modules-load.d/pi-privacy-gateway.conf
done
printf 'net.ipv4.ip_forward = 1\nnet.ipv4.conf.all.src_valid_mark = 1\n' > /etc/sysctl.d/99-pi-privacy-gateway.conf
sysctl -q --system && ok "IP forwarding on, WireGuard module loads at boot"

# hardware watchdog: a frozen host resets itself within ~10 s (Raspberry Pi and most boards)
if [ -e /dev/watchdog ] && [ ! -f /etc/systemd/system.conf.d/watchdog.conf ]; then
  mkdir -p /etc/systemd/system.conf.d
  printf '[Manager]\nRuntimeWatchdogSec=10\nRebootWatchdogSec=2min\n' > /etc/systemd/system.conf.d/watchdog.conf
  systemctl daemon-reexec && ok "hardware watchdog enabled"
fi

# clock: no battery clock on a Pi + Tor needs the right time + in Tor mode DNS needs Tor = a deadlock
# at boot. Give the time service DNS-free servers and add an HTTPS-time fallback (scripts/pgw-clockfix).
DNSFREE="216.239.35.0 216.239.35.4 216.239.35.8"   # Google's anycast time servers
if command -v chronyc >/dev/null; then
  mkdir -p /etc/chrony/sources.d /etc/chrony/conf.d
  printf '# no DNS needed (works even when DNS depends on Tor)\n' > /etc/chrony/sources.d/pgw-dnsfree.sources
  for ip in $DNSFREE; do echo "server $ip iburst" >> /etc/chrony/sources.d/pgw-dnsfree.sources; done
  printf '# no battery clock: always allow stepping a wrong clock\nmakestep 1 -1\n' > /etc/chrony/conf.d/pgw-step.conf
  systemctl restart chrony 2>/dev/null || systemctl restart chronyd 2>/dev/null || true
elif systemctl list-unit-files systemd-timesyncd.service >/dev/null 2>&1; then
  mkdir -p /etc/systemd/timesyncd.conf.d
  printf '[Time]\nFallbackNTP=%s\n' "$DNSFREE" > /etc/systemd/timesyncd.conf.d/pgw.conf
  systemctl restart systemd-timesyncd 2>/dev/null || true
fi
install -m 755 scripts/pgw-clockfix /usr/local/sbin/pgw-clockfix
cat > /etc/systemd/system/pgw-clockfix.service <<'UNIT'
[Unit]
Description=Set the clock from HTTPS if NTP has not synced 90 s after boot (Tor needs a correct clock)
Wants=network-online.target
After=network-online.target time-sync.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pgw-clockfix
TimeoutStartSec=180
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable -q pgw-clockfix.service && ok "clock: DNS-free time servers + HTTPS fallback at boot"

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
  # traffic inspection (Suricata) needs ~1.5 GB RAM: switch it on only where it fits
  if [ "$(awk '/^MemTotal/ {print $2}' /proc/meminfo)" -ge 3500000 ]; then
    sed -i 's/^IDS=.*/IDS=on/' .env && ok "threat inspection (IDS) on: this machine has enough RAM"
  fi
else
  ok ".env exists"
fi
mkdir -p data/gateway data/wireguard data/adguard && chmod 700 data/gateway data/wireguard

# 6. AdGuard Home pre-configured with the login from .env, so there is no setup wizard to click through
WIZARD=0
if [ ! -f data/adguard/conf/AdGuardHome.yaml ]; then
  # shellcheck disable=SC1091
  . ./.env
  if scripts/adguard-seed.sh "$ADGUARD_USER" "$ADGUARD_PASSWORD" data/adguard/conf >/dev/null; then
    mkdir -p data/adguard/work; ok "AdGuard Home pre-configured (login: $ADGUARD_USER / the ADGUARD_PASSWORD in .env)"
  else
    WIZARD=1; warn "could not pre-configure AdGuard Home: finish its setup wizard at :3000 after starting"
  fi
fi

WIZ_STEP="(AdGuard Home is already set up)"
[ "$WIZARD" = 1 ] && WIZ_STEP="open http://$(hostname -I | awk '{print $1}'):3000 and finish AdGuard's wizard (port 3000, DNS on 53, login from .env)"
cat <<EOF

Next:
  1. docker compose up -d --build
  2. $WIZ_STEP
  3. docker compose exec gateway pgw add-peer phone      # scan the QR with the WireGuard app
  4. dashboard: http://10.13.13.1/dashboard (through the VPN) or http://$(hostname -I | awk '{print $1}')/dashboard
EOF
