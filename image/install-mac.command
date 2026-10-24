#!/bin/bash
# Pi Privacy Gateway - one-click SD card installer for macOS (double-click it in Finder).
# Opens Raspberry Pi Imager with "Pi Privacy Gateway" in its OS list. Answer NO to OS customisation.
REPO=https://github.com/JMJAJ/pi-privacy-gateway/releases/latest/download/os_list.json
APP="/Applications/Raspberry Pi Imager.app"
if [ ! -d "$APP" ]; then
  if command -v brew >/dev/null; then brew install --cask raspberry-pi-imager
  else open https://www.raspberrypi.com/software/; echo "Install Raspberry Pi Imager, then run this again."; exit 1; fi
fi
"$APP/Contents/MacOS/rpi-imager" --repo "$REPO" >/dev/null 2>&1 &
echo "Raspberry Pi Imager is opening: Choose OS -> Pi Privacy Gateway, then pick your SD card."
