#!/bin/bash
# Pre-configure AdGuard Home (login, DNS port, encrypted upstreams, blocklists) so there is no setup
# wizard to click through. Usage: scripts/adguard-seed.sh <user> <password> <conf dir>
# Writes <conf dir>/AdGuardHome.yaml only if it doesn't exist yet. Needs docker (for the bcrypt hash).
set -euo pipefail
user=$1 pass=$2 dir=$3
conf="$dir/AdGuardHome.yaml"
[ -f "$conf" ] && { echo "exists: $conf"; exit 0; }
# bcrypt hash from the official Apache image (nothing installed on the host); Go reads it as $2a$
hash=$(docker run --rm httpd:2.4-alpine htpasswd -nbB "$user" "$pass" 2>/dev/null | cut -d: -f2- | sed 's/^\$2y\$/$2a$/')
[ -n "$hash" ] || { echo "could not create the password hash" >&2; exit 1; }
mkdir -p "$dir"
umask 077
cat > "$conf" <<YAML
http:
  address: 0.0.0.0:3000
users:
  - name: $user
    password: $hash
dns:
  bind_hosts:
    - 0.0.0.0
  port: 53
  upstream_dns:
    - https://dns.quad9.net/dns-query
    - https://cloudflare-dns.com/dns-query
  bootstrap_dns:
    - 9.9.9.10
    - 1.1.1.1
  enable_dnssec: true
filters:
  - enabled: true
    url: https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt
    name: AdGuard DNS filter
    id: 1
  - enabled: true
    url: https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt
    name: HaGeZi Multi PRO
    id: 2
schema_version: 28
YAML
echo "written: $conf"
