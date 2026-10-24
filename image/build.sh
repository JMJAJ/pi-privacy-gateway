#!/bin/bash
# Builds a ready-to-flash image: the official Ubuntu Server 24.04 LTS image for Raspberry Pi
# (checksum-verified) with this project's first-boot files added to its boot partition.
# Needs: curl, xz-utils, mtools, fdisk.  Output: pi-privacy-gateway-<version>-raspi-arm64.img.xz
set -euo pipefail
cd "$(dirname "$0")"
VERSION=${1:-dev}
BASE=https://cdimage.ubuntu.com/releases/24.04/release
NAME=$(curl -fsSL "$BASE/" | grep -oE 'ubuntu-24\.04(\.[0-9]+)?-preinstalled-server-arm64\+raspi\.img\.xz' | sort -uV | tail -1)
[ -n "$NAME" ] || { echo "could not find the Ubuntu Raspberry Pi image" >&2; exit 1; }
echo "base image: $NAME"
curl -fsSL -o base.img.xz "$BASE/$NAME"
curl -fsSL "$BASE/SHA256SUMS" | grep " \*\?$NAME\$" | awk '{print $1"  base.img.xz"}' | sha256sum -c -
xz -d -T0 base.img.xz
# boot partition (FAT, partition 1): write our files with mtools, no root or loop devices needed
# sfdisk -d prints e.g. "base.img1 : start=        2048, size= ..."
START=$(sfdisk -d base.img | sed -n 's/^base\.img1 *: *start= *\([0-9][0-9]*\).*/\1/p')
[ -n "$START" ] || { echo "could not find the boot partition" >&2; exit 1; }
OFF=$((START * 512))
for f in user-data network-config; do mcopy -o -i "base.img@@$OFF" "$f" "::$f"; done
mdir -i "base.img@@$OFF" ::user-data ::network-config
OUT="pi-privacy-gateway-$VERSION-raspi-arm64.img"
mv base.img "$OUT"
xz -T0 -6 "$OUT"
sha256sum "$OUT.xz" > "$OUT.xz.sha256"
ls -lh "$OUT.xz"
