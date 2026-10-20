#!/bin/bash
# Smoke test: builds the gateway image and runs it in an ISOLATED network namespace
# (normal Docker network, not host networking), so nothing touches the machine running the
# test. WARP is replaced by an offline dummy (PGW_TEST=1). Checks the parts that don't need
# the internet: startup, kill switch, routing rules, device management, mode switching
# failing closed, and the dashboard API.
set -uo pipefail
cd "$(dirname "$0")/.."
IMG=pgw-smoke:test
C=pgw-smoke
pass=0 fail=0
t() { if eval "$2" >/dev/null 2>&1; then echo "  ok    $1"; pass=$((pass+1)); else echo "  FAIL  $1"; fail=$((fail+1)); fi; }
x() { docker exec "$C" sh -c "$1"; }

docker build -q --network host -t "$IMG" gateway >/dev/null || { echo "build failed"; exit 1; }
docker rm -f "$C" >/dev/null 2>&1
docker run -d --name "$C" --privileged -e PGW_TEST=1 -e DASHBOARD_PORT=8080 -v /lib/modules:/lib/modules:ro "$IMG" >/dev/null
for _ in $(seq 1 30); do x "ip link show wg1" >/dev/null 2>&1 && break; sleep 1; done
sleep 4

echo "startup"
t "VPN server wg1 is up"                 "x 'ip link show wg1'"
t "WARP stand-in wg0 is up"              "x 'ip link show wg0'"
t "Tor is running"                       "x 'pgrep -x tor'"
t "server listens on UDP 51820"          "x 'wg show wg1 listen-port | grep -qx 51820'"
t "keys are private (0600)"              "x 'stat -c %a /etc/wireguard/wg1.conf | grep -qx 600'"
echo "kill switch"
t "armed in FORWARD"                     "x 'iptables -C FORWARD -j PIX_FWD'"
t "rejects everything not to WARP"       "x 'iptables -S PIX_FWD | grep -q \"\\-i wg1 -j REJECT\"'"
t "only wg1 -> wg0 allowed in warp mode" "x 'iptables -S PIX_FWD | grep -q \"\\-i wg1 -o wg0 -j ACCEPT\"'"
t "IPv6 from devices rejected"           "x 'ip6tables -S PIX_FWD | grep -q \"\\-i wg1 -j REJECT\"'"
t "WARP rule priorities fixed at 98/99"  "x 'ip rule | grep -q ^98: && ip rule | grep -q ^99:'"
echo "devices"
t "add-peer creates config + QR"         "x 'pgw add-peer testphone && test -s /config/peers/testphone.conf && test -s /config/peers/testphone.png'"
t "peer is live on the server"           "x 'wg show wg1 allowed-ips | grep -q 10.13.13.2/32'"
t "duplicate names refused"              "! x 'pgw add-peer testphone'"
t "bad names refused"                    "! x 'pgw add-peer \"a b;rm\"'"
t "remove-peer revokes it"               "x 'pgw remove-peer testphone && ! wg show wg1 allowed-ips | grep -q 10.13.13.2'"
echo "exit modes"
t "provider mode refused without config" "! x 'pgw mode provider'"
x 'timeout 15 pgw-exit set tor' >/dev/null 2>&1   # offline: Tor can't connect
t "tor mode fails CLOSED when offline"   "x 'iptables -S PIX_FWD | grep -q \"\\-i wg1 -j REJECT\" && ! iptables -S PIX_FWD | grep -q \"\\-o wg0 -j ACCEPT\"'"
t "tor mode redirects TCP to Tor"        "x 'iptables -t nat -S PIX_NAT | grep -q \"REDIRECT --to-ports 9040\"'"
x 'pgw-exit set warp' >/dev/null 2>&1
t "back to warp"                          "x 'iptables -S PIX_FWD | grep -q \"\\-o wg0 -j ACCEPT\"'"
echo "dashboard"
t "serves the page"                      "x 'curl -sf http://127.0.0.1:8080/dashboard | grep -q \"Pi Privacy Gateway\"'"
t "mode API answers"                     "x 'curl -sf http://127.0.0.1:8080/api/mode | grep -q \"\\\"mode\\\": \\\"warp\\\"\"'"
t "mode switch needs the CSRF header"    "x 'curl -s -X POST -d mode=tor http://127.0.0.1:8080/api/mode | grep -q \"bad request\"'"
t "traceroute rejects shell tricks"      "x 'curl -s \"http://127.0.0.1:8080/api/trace?target=1.1.1.1;id\" | grep -q invalid'"
t "live stream sends data"               "x 'timeout 4 curl -sN http://127.0.0.1:8080/api/stream | grep -q ^data:'"

docker rm -f "$C" >/dev/null
echo; echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
