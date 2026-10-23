#!/bin/bash
# Smoke test: builds the gateway image and runs it UNPRIVILEGED (NET_ADMIN + NET_RAW only, like
# docker-compose.yml) in an ISOLATED network namespace, so nothing touches the machine running the
# test. WARP and the VPN provider are replaced by offline stand-ins (PGW_TEST=1, dummy provider
# keys). Checks everything that doesn't need the internet: startup, kill switch, routing, device
# management, per-device exits, failover, fail-closed behaviour and the dashboard API.
# Needs: docker, and the wireguard module on the host (the script loads it).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
IMG=pgw-smoke:test
C=pgw-smoke
pass=0 fail=0
t() { if eval "$2" >/dev/null 2>&1; then echo "  ok    $1"; pass=$((pass+1)); else echo "  FAIL  $1"; fail=$((fail+1)); fi; }
dump() { echo "--- debug"; x 'cat /config/mode; ls -l /config; curl -s -m 5 http://127.0.0.1:8080/api/mode; echo; ip rule; iptables -S PIX_FWD' 2>&1; docker logs --tail 40 "$C" 2>&1; }
x() { docker exec "$C" sh -c "$1"; }
api() { x "curl -s -H 'Content-Type: application/json' -H 'X-Pi-Control: 1' -d '$2' http://127.0.0.1:8080$1"; }
waitfor() { for _ in $(seq 1 "$2"); do eval "$1" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

modprobe wireguard 2>/dev/null || true
docker build -q --network host -t "$IMG" gateway >/dev/null || { echo "build failed"; exit 1; }
docker rm -f "$C" >/dev/null 2>&1

# config volume with a dummy provider (valid keys, unreachable endpoint)
CFGDIR=$(mktemp -d)
pk=$(docker run --rm --entrypoint wg "$IMG" genkey); pub=$(docker run --rm --entrypoint wg "$IMG" genkey | docker run --rm -i --entrypoint wg "$IMG" pubkey)
printf '[Interface]\nPrivateKey = %s\nAddress = 10.2.0.2/32\n[Peer]\nPublicKey = %s\nAllowedIPs = 0.0.0.0/0\nEndpoint = 127.0.0.1:9\n' "$pk" "$pub" > "$CFGDIR/provider.conf"

docker run -d --name "$C" --cap-add NET_ADMIN --cap-add NET_RAW --security-opt no-new-privileges:true \
  --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  -e PGW_TEST=1 -e DASHBOARD_PORT=8080 -e EXIT_FAILOVER=warp -e PROVIDER_NAME=TestVPN \
  -v "$CFGDIR:/config" "$IMG" >/dev/null
waitfor "x 'ip link show wg1'" 40
sleep 4

echo "startup (unprivileged)"
t "container has no SYS_ADMIN capability" "x 'python3 -c \"import re;c=int(re.search(r\\\"CapEff:\\\\s*(\\\\w+)\\\",open(\\\"/proc/1/status\\\").read()).group(1),16);exit(c>>21&1)\"'"
t "VPN server wg1 is up"                 "x 'ip link show wg1'"
t "WARP stand-in wg0 is up"              "x 'ip link show wg0'"
t "provider tunnel wg2 is up"            "x 'ip link show wg2'"
t "Tor is running"                       "x 'pgrep -x tor'"
t "alert service is running"             "x 'pgrep -f pgw-alert'"
t "server listens on UDP 51820"          "x 'wg show wg1 listen-port | grep -qx 51820'"
t "keys are private (0600)"              "x 'stat -c %a /etc/wireguard/wg1.conf | grep -qx 600'"
echo "kill switch"
t "armed in FORWARD"                     "x 'iptables -C FORWARD -j PIX_FWD'"
t "rejects everything not to WARP"       "x 'iptables -S PIX_FWD | grep -q \"\\-i wg1 -j REJECT\"'"
t "only wg1 -> wg0 allowed in warp mode" "x 'iptables -S PIX_FWD | grep -q \"\\-i wg1 -o wg0 -j ACCEPT\"'"
t "IPv6 from devices rejected"           "x 'ip6tables -S PIX_FWD | grep -q \"\\-i wg1 -j REJECT\"'"
t "WARP rule priorities fixed at 98/99"  "x 'ip rule | grep -q ^98: && ip rule | grep -q ^99:'"
t "Android DoT probe refused instantly"  "x 'iptables -S PIX_IN | grep -q \"dport 853 -j REJECT\"'"
echo "devices (CLI)"
t "add-peer creates config + QR"         "x 'pgw add-peer phone && test -s /config/peers/phone.conf && test -s /config/peers/phone.png'"
t "peer is live with a preshared key"    "x 'wg show wg1 preshared-keys | grep -v none | grep -q .'"
t "second device gets the next address"  "x 'pgw add-peer laptop >/dev/null && wg show wg1 allowed-ips | grep -q 10.13.13.3/32'"
t "duplicate names refused"              "! x 'pgw add-peer phone'"
t "bad names refused"                    "! x 'pgw add-peer \"a b;rm\"'"
echo "per-device exits"
x 'timeout 20 pgw device phone tor' >/dev/null 2>&1
t "phone alone is sent into Tor"         "x 'iptables -t nat -S PIX_NAT | grep -q \"\\-s 10.13.13.2/32.*REDIRECT --to-ports 9040\"'"
t "phone can't bypass Tor (fail closed)" "x 'iptables -S PIX_FWD | grep -q \"\\-s 10.13.13.2/32 -i wg1 -j REJECT\" && ! iptables -S PIX_FWD | grep -q \"\\-s 10.13.13.2/32 -i wg1 -o wg0\"'"
t "others still use WARP"                "x 'iptables -S PIX_FWD | grep -q \"^-A PIX_FWD -i wg1 -o wg0 -j ACCEPT\"'"
x 'timeout 20 pgw device laptop provider' >/dev/null 2>&1
# (provider is offline here, so failover may already have moved it to WARP: either table is right)
t "laptop gets its own routing rule"     "x 'grep -q \"10.13.13.3 provider\" /config/device-modes && ip rule | grep -q \"^94:.*from 10.13.13.3 iif wg1\"'"
t "failover moves it to WARP (provider down)" "waitfor \"x 'test -f /run/pgw/failover && iptables -S PIX_FWD | grep -q \\\"\\-s 10.13.13.3/32 -i wg1 -o wg0 -j ACCEPT\\\"'\" 40"
x 'pgw device phone default; pgw device laptop default' >/dev/null 2>&1
t "overrides cleared"                    "x '! test -s /config/device-modes'"
t "remove-peer revokes it"               "x 'pgw remove-peer laptop && ! wg show wg1 allowed-ips | grep -q 10.13.13.3'"
echo "default exit modes"
x 'timeout 15 pgw-exit set tor' >/dev/null 2>&1   # offline: Tor can't connect
t "tor mode fails CLOSED when offline"   "x 'iptables -S PIX_FWD | grep -q \"\\-i wg1 -j REJECT\" && ! iptables -S PIX_FWD | grep -q \"^-A PIX_FWD -i wg1 -o wg0 -j ACCEPT\"'"
t "tor mode redirects TCP to Tor"        "x 'iptables -t nat -S PIX_NAT | grep -q \"\\-i wg1 -p tcp.*REDIRECT --to-ports 9040\"'"
x 'pgw-exit set warp' >/dev/null 2>&1
t "back to warp"                         "x 'iptables -S PIX_FWD | grep -q \"^-A PIX_FWD -i wg1 -o wg0 -j ACCEPT\"'"
echo "dashboard"
t "serves the page"                      "x 'curl -sf http://127.0.0.1:8080/dashboard | grep -q \"Pi Privacy Gateway\"'"
t "strict CSP header"                    "x 'curl -s -D - -o /dev/null http://127.0.0.1:8080/dashboard | grep -i content-security-policy | grep -q \"frame-ancestors .none.\"'"
t "mode API answers"                     "x 'curl -sf http://127.0.0.1:8080/api/mode | grep -q \"\\\"mode\\\": \\\"warp\\\"\"'"
t "mode switch needs the CSRF header"    "x 'curl -s -X POST -d mode=tor http://127.0.0.1:8080/api/mode | grep -q \"bad request\"'"
t "add device from the dashboard (QR)"   "api /api/devices/add '{\"name\":\"tablet\"}' | grep -q 'data:image/png;base64'"
t "device list shows it"                 "x 'curl -sf http://127.0.0.1:8080/api/devices | grep -q tablet'"
t "per-device exit from the dashboard"   "api /api/devices/exit '{\"name\":\"tablet\",\"mode\":\"warp\"}' | grep -q '\"ok\": true' && x 'grep -q \"10.13.13.3 warp\" /config/device-modes'"
t "device API refuses bad names"         "api /api/devices/add '{\"name\":\"../etc\"}' | grep -q error"
t "device API needs the CSRF header"     "x 'curl -s -d \"{\\\"name\\\":\\\"x\\\"}\" http://127.0.0.1:8080/api/devices/add | grep -q \"bad request\"'"
t "remove device from the dashboard"     "api /api/devices/remove '{\"name\":\"tablet\"}' | grep -q '\"ok\": true'"
t "history API answers"                  "x 'curl -sf \"http://127.0.0.1:8080/api/history?range=24h\" | grep -q \"\\\"range\\\": \\\"24h\\\"\"'"
t "leak-test API validates input"        "api /api/leak/dns '{\"token\":\"x;y\"}' | grep -q 'bad token'"
t "Tor restart needs the CSRF header"    "x 'curl -s -X POST http://127.0.0.1:8080/api/tor/restart | grep -q \"bad request\"'"
t "Tor restart works and Tor comes back" "api /api/tor/restart '{}' | grep -q '\"ok\": true' && waitfor \"x 'pgrep -x tor'\" 30"
t "Tor exit country rejects junk"        "api /api/tor/exit '{\"country\":\"xx\"}' | grep -q 'unknown country'"
t "Tor exit country is saved"            "api /api/tor/exit '{\"country\":\"de\"}' >/dev/null; x 'grep -qx de /config/tor-exit'"
t "traceroute rejects shell tricks"      "x 'curl -s \"http://127.0.0.1:8080/api/trace?target=1.1.1.1;id\" | grep -q invalid'"
t "live stream sends data"               "x 'timeout 4 curl -sN http://127.0.0.1:8080/api/stream | grep -q ^data:'"

[ "$fail" -eq 0 ] || dump
docker rm -f "$C" >/dev/null
rm -rf "$CFGDIR"
echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
