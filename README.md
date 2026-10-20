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

- **WireGuard VPN server** for your devices, with QR codes for phones (`pgw add-peer phone`)
- **Three exit modes**, switchable for all devices at once from the dashboard, a CLI or the Windows tray app
- **Kill switch** that fails closed, armed before the VPN interface even comes up
- **AdGuard Home** DNS filtering with DNSSEC and encrypted (DoH) upstreams; in Tor mode DNS resolves through Tor too
- **Live dashboard**: your traffic layer by layer, live throughput per device and interface, Tor circuit with relay
  countries, live traceroute (through WARP *or* along your real ISP path), DNS query log, latency per layer, system
  health, and an estimated power draw on a Raspberry Pi 4. No external requests: nothing on the page loads from the internet.
- **Private by default**: your real IP, the DNS log, traceroute and mode switching are only available to devices on the VPN,
  not to everyone on your Wi-Fi. Mode switching is CSRF-protected.
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
docker compose exec gateway pgw mode tor            # switch exit: warp | provider | tor
docker compose exec gateway pgw status              # health check
```

Device configs (with their private keys) are stored in `data/gateway/peers/`. Keep `data/` private and backed up.

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

## Security notes & limits

- The gateway container runs **privileged with host networking**: it has to create interfaces, routes and firewall
  rules on the host. Treat the host as part of your security boundary, and keep it updated.
- **WARP is not anonymity.** Cloudflare sees your IP. Use the provider or Tor mode when that matters.
- **Your browser identifies you more than your IP does** (cookies, logins, fingerprinting). Pair this with a
  privacy-focused browser; for real anonymity use Tor Browser.
- Power figures are an estimate (a Raspberry Pi 4 has no power sensor).

## Development

```bash
sudo bash tests/smoke.sh   # builds the image and runs 24 checks in an isolated network namespace
```

The smoke test uses an offline stand-in for WARP (`PGW_TEST=1`) and never touches the host's own network.

## License

MIT. Uses [wgcf](https://github.com/ViRb3/wgcf) to register WARP, [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome),
[Tor](https://www.torproject.org/) and [WireGuard](https://www.wireguard.com/).
