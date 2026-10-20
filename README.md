# Pi Privacy Gateway

A home privacy gateway for a Raspberry Pi (or any Linux box) in one `docker compose up`.
Your phone, laptop and PC connect to it with the official WireGuard app; it blocks ads and
trackers for all of them and sends their traffic out through the exit you choose, switchable
live from a dashboard:

| Exit | Speed* | Who sees what |
|---|---|---|
| **WARP** (default) | fast | Your ISP sees only encrypted traffic to Cloudflare. Cloudflare sees your IP and the sites you visit (not HTTPS content). |
| **Provider** (Proton, Mullvad, … via WireGuard) | fast | Runs *inside* WARP (double hop): Cloudflare sees your IP but only encrypted traffic to the provider; the provider sees the sites but never your IP. **No single company sees both.** |
| **Tor** | slow | Sites see a Tor exit relay. Tor runs inside WARP, so your ISP can't even see you use Tor. TCP only: UDP is blocked so nothing slips around Tor. |

<sub>*Measured on a Raspberry Pi 4 over a 5 GHz USB Wi-Fi uplink: ~70 Mbps via WARP, ~60 Mbps via the double hop.</sub>

All three modes are protected by a **kill switch**: if the chosen exit goes down, your devices lose
internet instead of leaking out through your normal connection.

```mermaid
flowchart LR
  D["Your devices<br/>WireGuard app"] -->|"wg1 · encrypted"| G
  subgraph G["Gateway (this project)"]
    A["AdGuard Home<br/>DNS filter"]
    K{"Kill switch +<br/>exit selector"}
  end
  K -->|warp| W["Cloudflare WARP"]
  K -->|provider| P["Proton / Mullvad / …"] --> W
  K -->|tor| T["Tor"] --> W
  W --> I(("Internet"))
```

## Features

- **WireGuard VPN server** for your devices, with preshared keys (post-quantum hardening) and QR codes —
  add, revoke and scan devices right from the dashboard, or with `pgw add-peer phone`
- **Three exit modes**, switchable for all devices at once from the dashboard, a CLI or the Windows tray app
- **Per-device exits**: e.g. the TV on fast WARP, your phone through the provider, one laptop always in Tor
- **Kill switch** that fails closed, armed before the VPN interface even comes up
- **Optional provider failover**: if the provider is down, its devices fall back to WARP instead of losing internet,
  and move back automatically when it recovers (`EXIT_FAILOVER=warp`, off by default)
- **Push alerts** to your phone via [ntfy](https://ntfy.sh) when an exit, Tor, DNS or the kill switch breaks, the
  CPU overheats, the power supply sags, the disk fills or the clock drifts — and when it recovers
- **30-day history** of throughput, CPU, temperature and power, stored locally in SQLite
- **Built-in leak test**: checks from your own browser that your exit IP, DNS resolver, IPv6 and WebRTC all
  go where the gateway says they should
- **AdGuard Home** DNS filtering with DNSSEC and encrypted (DoH) upstreams; in Tor mode DNS resolves through Tor too
- **Live dashboard**: your traffic layer by layer, live throughput per device and interface, Tor circuit with relay
  countries, live traceroute (through WARP *or* along your real ISP path), DNS query log, latency per layer, system
  health, and an estimated power draw and electricity cost on a Raspberry Pi 4. Nothing on the page loads from the
  internet (the leak test only contacts 1.1.1.1 when you press it).
- **Private by default**: your real IP, the DNS log, traceroute and all controls are only available to devices on the VPN,
  not to everyone on your Wi-Fi; device management can be limited further to your own computer (`ADMIN_IPS`).
  Every control is CSRF-protected.
- **Unprivileged container**: only the `NET_ADMIN` and `NET_RAW` capabilities, `no-new-privileges`; release images are
  multi-arch, signed with Sigstore and ship an SBOM and build provenance.
- **Self-healing**: tunnels, routing rules and the kill switch are re-checked every 5 seconds; quiet when nobody watches.

## Requirements

- Linux with WireGuard in the kernel (5.6+): Raspberry Pi OS, Ubuntu, Debian, …
- Docker with the compose plugin (`scripts/setup.sh` can install it)
- Port 53 free on the host (setup handles Ubuntu's systemd-resolved stub)
- A correct clock (Tor depends on it; see [extras/host](extras/host/README.md) for a Pi without a clock battery)

Tested on a Raspberry Pi 4 (arm64, Ubuntu 25.10); CI builds and tests on x86-64 and arm64.

## Quick start

```bash
git clone https://github.com/JMJAJ/pi-privacy-gateway.git
cd pi-privacy-gateway
sudo ./scripts/setup.sh          # checks the host, creates .env
sudo docker compose up -d --build
```

1. Open `http://<gateway-ip>:3000` and finish AdGuard's setup wizard (keep the admin interface on port **3000**
   and DNS on port **53**). Use the login from `.env` (`ADGUARD_USER` / `ADGUARD_PASSWORD`), or put the one you
   chose into `.env` and run `docker compose up -d` again.
2. Add a device and scan the QR code with the WireGuard app:
   ```bash
   sudo docker compose exec gateway pgw add-peer phone
   ```
3. Turn the tunnel on in the app, then open the dashboard: **http://10.13.13.1/dashboard**.
   On a phone, use *Add to Home screen* to get an app icon.

## Everyday commands

```bash
docker compose exec gateway pgw add-peer laptop     # new device (prints a QR code)
docker compose exec gateway pgw qr laptop           # show its QR code again
docker compose exec gateway pgw list                # devices and when they last connected
docker compose exec gateway pgw remove-peer laptop  # revoke a device
docker compose exec gateway pgw mode tor            # switch exit for everyone: warp | provider | tor
docker compose exec gateway pgw device laptop tor   # this device only (back with: default)
docker compose exec gateway pgw status              # health check
```

Device configs (with their private keys) are stored in `data/gateway/peers/`. Keep `data/` private and backed up —
for example encrypt it to a key that lives on another computer, so the backup is useless to anyone who takes the Pi:

```bash
tar -czf - data .env | openssl cms -encrypt -aes256 -binary -outform DER backup.crt > pgw-backup.p7m
```

## Per-device exits

Every device follows the default exit unless you give it its own: pick it from the dropdown next to the device in
the dashboard, or `pgw device <name> warp|provider|tor|default`. The kill switch applies per device too — a device
set to Tor can never leave outside Tor, even while everyone else uses WARP. In Tor mode the device's DNS is also
resolved through Tor (a per-device AdGuard upstream).

## Alerts

Install the [ntfy](https://ntfy.sh) app, subscribe to a long random topic and set it in `.env`:

```bash
NTFY_URL=https://ntfy.sh/pgw-<20 random letters>
```

Each check must fail twice in a row before you're told, so short hiccups stay quiet; you get a second message when
it's fixed. Alerts that can't be sent (the internet is down) are queued and delivered later. Use your own ntfy
server if you prefer.

## Leak test

The dashboard's *Leak test* runs in your browser on the device you want to check: it compares the IP the internet
sees (IPv4 and IPv6) with the exit the gateway assigned to that device, checks that a unique DNS lookup arrived at
the gateway's own resolver, and lists the addresses WebRTC would reveal to a website.

## Adding a VPN provider (Proton, Mullvad, IVPN, …)

1. Download a **WireGuard** configuration from your provider. For Proton VPN:
   *Account → Downloads → WireGuard configuration*, platform *GNU/Linux*, NetShield off (AdGuard already filters),
   pick a server, *Create*, *Download*. The free plan works; it allows one connection at a time.
2. Save it as `data/gateway/provider.conf` and set `PROVIDER_NAME=Proton` in `.env`.
3. `docker compose up -d` and pick the new exit in the dashboard.

The provider tunnel runs inside WARP automatically (its MTU is adjusted to fit).

## Using it away from home

Set `PUBLIC_ENDPOINT` in `.env` to a DynDNS name pointing at your home IP, forward UDP `WG_PORT` (51820)
on your router to the gateway, then add (or re-add) devices. Only WireGuard is exposed; it does not answer
anything without a valid key.

## How the kill switch works

The gateway inserts its own chains at the top of the firewall (it never edits your ufw/firewalld/Docker rules):

- `PIX_FWD`: traffic from VPN devices may only leave through the active exit (`wg0` WARP or `wg2` provider);
  everything else is rejected. In Tor mode, nothing is forwarded at all: TCP is redirected into Tor's transparent proxy.
- `PIX_IN`: lets VPN devices reach DNS and the dashboard on the gateway, even if the host firewall denies by default.
- It is armed *before* the VPN server starts, and re-armed automatically if anything removes it.
- Routing rule priorities are fixed (exit selector 95, WARP 98/99), so the order services start in can never send
  traffic to the wrong exit.

Mode switches wait until the new exit actually works. Until then the kill switch stays closed.

## Windows tray app

[`extras/windows`](extras/windows) has a small tray icon (green WARP, magenta provider, purple Tor, grey off) to toggle
the VPN and switch exits without opening the dashboard. Run `install-tasks.ps1` once as administrator. It creates
scheduled tasks so the tray can start/stop the tunnel without UAC prompts, with the task scripts stored in an
admin-only folder.

## Optional host tuning

[`extras/host`](extras/host/README.md): run a Pi headless and cooler (we measured 16.5 % → 0.9 % idle CPU and
−5 °C), keep the clock right for Tor, and fail over between two Wi-Fi radios.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `wg-quick: Permission denied` reading a config | Ubuntu's AppArmor profile only lets `wg-quick` read `/etc/wireguard`. Configs are kept there for this reason; don't move them. |
| AdGuard won't start: port 53 in use | systemd-resolved's stub listener. `scripts/setup.sh` can disable it. |
| Tor mode never connects | The clock is wrong. Check `timedatectl`; see [extras/host](extras/host/README.md). |
| Devices connect but have no internet | Check `pgw status`. In provider/Tor mode the kill switch blocks traffic until that exit works. |
| Dashboard shows "View only" | You opened it via the LAN address. Open it through the VPN (http://10.13.13.1) to switch exits. |

## How it compares

| | This project | [PiVPN](https://pivpn.io) | [wg-easy](https://github.com/wg-easy/wg-easy) | [Pi-hole](https://pi-hole.net) + VPN | [Algo](https://github.com/trailofbits/algo) |
|---|---|---|---|---|---|
| WireGuard server + QR codes | ✓ | ✓ | ✓ | separate | ✓ |
| Ad/tracker DNS filter | ✓ AdGuard | – | – | ✓ | basic |
| Hides your IP from sites | ✓ WARP / provider / Tor | – (home IP) | – (home IP) | – | ✓ (cloud VPS) |
| Double hop, no single company sees both ends | ✓ | – | – | – | – |
| Tor exit, per device | ✓ | – | – | – | – |
| Kill switch (fails closed) | ✓ | – | – | – | – |
| Live dashboard, history, leak test | ✓ | – | traffic only | DNS only | – |
| Push alerts | ✓ | – | – | – | – |
| Runs at home, no monthly cost | ✓ | ✓ | ✓ | ✓ | – (VPS) |

The others are good at what they do — PiVPN and wg-easy are the simplest way to reach your home network from outside.
This project is for the opposite direction: making your devices' traffic *leave* privately.

## Threat model

**Protects against**
- Your ISP, mobile carrier or a public Wi-Fi operator logging or selling the sites you visit (all they see is
  encrypted WireGuard to your home and encrypted traffic to Cloudflare).
- Sites and ad networks learning your home IP / location (provider or Tor mode).
- One VPN company holding both your identity and your browsing (provider mode: double hop).
- Leaks when an exit fails (kill switch), DNS leaks (all DNS forced through AdGuard), IPv6 leaks (blocked).
- Ads, trackers and malware domains on every device, including ones where you can't install a blocker (TVs, consoles).

**Does not protect against**
- Your browser identifying you: logins, cookies and fingerprinting. Use a privacy browser; for anonymity, Tor Browser.
- A compromised gateway host or someone with physical access to it (it holds all keys — encrypt your backups).
- Global adversaries correlating traffic timing; Cloudflare and your provider cooperating.
- Malware on your own devices.

## Security notes & limits

- The gateway container is **not privileged**, but it has `NET_ADMIN` on the host's network stack (it has to create
  interfaces, routes and firewall rules). Treat the host as part of your security boundary, and keep it updated.
- The dashboard and AdGuard admin are only reachable through the VPN; nothing is exposed to the internet except the
  WireGuard port, which ignores anything without a valid key.
- **WARP is not anonymity.** Cloudflare sees your IP. Use the provider or Tor mode when that matters.
- **Your browser identifies you more than your IP does** (cookies, logins, fingerprinting). Pair this with a
  privacy-focused browser; for real anonymity use Tor Browser.
- Power figures are an estimate (a Raspberry Pi 4 has no power sensor).

## Development

```bash
sudo bash tests/smoke.sh   # builds the image and runs ~50 checks in an isolated network namespace
```

The smoke test runs the container unprivileged exactly like `docker-compose.yml` does, uses offline stand-ins for
WARP and the provider (`PGW_TEST=1`) and never touches the host's own network. It covers the kill switch, per-device
exits, failover, fail-closed Tor mode and the dashboard API (including CSRF and input validation).

Releases (`v*` tags) publish signed multi-arch images to `ghcr.io/jmjaj/pi-privacy-gateway`. Verify one with:

```bash
cosign verify ghcr.io/jmjaj/pi-privacy-gateway:latest \
  --certificate-identity-regexp 'https://github.com/JMJAJ/pi-privacy-gateway/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## License

MIT. Uses [wgcf](https://github.com/ViRb3/wgcf) to register WARP, [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome),
[Tor](https://www.torproject.org/) and [WireGuard](https://www.wireguard.com/).
