#!/bin/bash
# Pi Privacy Gateway - one-click SD card installer for Linux.
# Opens Raspberry Pi Imager with "Pi Privacy Gateway" in its OS list. Use the customisation screen: your user, password, Wi-Fi (+ country), SSH on.
REPO=https://github.com/JMJAJ/pi-privacy-gateway/releases/latest/download/os_list.json
if ! command -v rpi-imager >/dev/null; then
  if command -v apt-get >/dev/null; then sudo apt-get install -y rpi-imager
  elif command -v snap >/dev/null; then sudo snap install rpi-imager
  else echo "Install Raspberry Pi Imager (https://www.raspberrypi.com/software/), then run this again."; exit 1; fi
fi
rpi-imager --repo "$REPO" >/dev/null 2>&1 &
echo "Raspberry Pi Imager is opening: Choose OS -> Pi Privacy Gateway, then pick your SD card."
