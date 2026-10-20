# Host extras (optional)

These run on the host, not in Docker. None are required.

## Run cooler and lighter on a Raspberry Pi

A gateway doesn't need a desktop. On the Pi 4 we built this on, these changes took idle CPU
from **16.5 % to 0.9 %**, temperature from **50.6 °C to 45.7 °C** and RAM from **936 MB to 587 MB**,
with no change in VPN speed.

```bash
# 1. no desktop / login screen (undo: sudo systemctl set-default graphical.target)
sudo systemctl set-default multi-user.target

# 2. services a headless gateway doesn't need (skip any you actually use)
sudo systemctl disable --now bluetooth ModemManager avahi-daemon.socket avahi-daemon \
     cups cups-browsed udisks2 power-profiles-daemon switcheroo-control accounts-daemon 2>/dev/null

# 3. firmware: Bluetooth and onboard audio off (Raspberry Pi, /boot/firmware/config.txt)
sudo sed -i 's/^dtparam=audio=on/dtparam=audio=off/' /boot/firmware/config.txt
echo 'dtoverlay=disable-bt' | sudo tee -a /boot/firmware/config.txt

# 4. keep logs small on the SD card
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' | sudo tee /etc/systemd/journald.conf.d/size.conf
sudo reboot
```

Wi-Fi power saving hurts a gateway badly (we measured 100+ ms extra latency). Turn it off:

```bash
sudo iw dev wlan0 set power_save off      # and persist it via your network manager
```

A passive aluminium case is the single biggest thermal improvement for a few euros.

## Keep the clock right (important for Tor)

A Raspberry Pi has no battery-backed clock and may boot months off. Tor refuses to connect
with a wrong clock, and in Tor mode DNS goes through Tor, so the host can deadlock. Give NTP
time sources by IP so it can always sync:

```bash
# chrony
printf 'server 162.159.200.1 iburst\nserver 162.159.200.123 iburst\n' | sudo tee /etc/chrony/sources.d/bootstrap-ip.sources
printf 'authselectmode prefer\nnocerttimecheck 1\n' | sudo tee /etc/chrony/conf.d/boot.conf
sudo systemctl restart chrony
```

## Two radios: automatic failover

[`pi-ip-failover`](pi-ip-failover) moves the gateway's LAN address to a second radio if the first
one disappears, and back when it returns. Edit the variables at the top, then follow the install
lines in the file.

## Hardware watchdog (done by setup.sh)

`scripts/setup.sh` enables the board's hardware watchdog through systemd
(`/etc/systemd/system.conf.d/watchdog.conf`: `RuntimeWatchdogSec=10`, `RebootWatchdogSec=2min`). If the host ever
freezes completely, it resets itself within about 10 seconds and the gateway comes back on its own, instead of
waiting for someone to pull the plug. Remove that file and run `systemctl daemon-reexec` to turn it off.
