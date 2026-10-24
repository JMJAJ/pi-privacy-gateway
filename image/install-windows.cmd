@echo off
rem Pi Privacy Gateway - one-click SD card installer for Windows.
rem Opens Raspberry Pi Imager (installs it with winget if missing) with "Pi Privacy Gateway" in its menu.
rem Then: Choose Device (Pi 4/5) - Choose OS: Pi Privacy Gateway - Choose Storage: your SD card - Next.
rem When Imager asks about OS customisation, answer NO: the image sets itself up on first boot.
setlocal
set "REPO=https://github.com/JMJAJ/pi-privacy-gateway/releases/latest/download/os_list.json"
set "IMAGER="
for %%P in ("%ProgramFiles%\Raspberry Pi Ltd\Imager\rpi-imager.exe" "%ProgramFiles%\Raspberry Pi Imager\rpi-imager.exe" "%ProgramFiles(x86)%\Raspberry Pi Imager\rpi-imager.exe" "%LocalAppData%\Programs\Raspberry Pi Imager\rpi-imager.exe") do if exist %%P set "IMAGER=%%~P"
if not defined IMAGER (
  echo Raspberry Pi Imager is not installed - installing the official version with winget...
  winget install -e --id RaspberryPiFoundation.RaspberryPiImager --accept-source-agreements --accept-package-agreements
  for %%P in ("%ProgramFiles%\Raspberry Pi Ltd\Imager\rpi-imager.exe" "%ProgramFiles%\Raspberry Pi Imager\rpi-imager.exe" "%ProgramFiles(x86)%\Raspberry Pi Imager\rpi-imager.exe" "%LocalAppData%\Programs\Raspberry Pi Imager\rpi-imager.exe") do if exist %%P set "IMAGER=%%~P"
)
if not defined IMAGER (
  echo Could not find Raspberry Pi Imager. Install it from https://www.raspberrypi.com/software/ and run this again.
  pause & exit /b 1
)
echo Opening Raspberry Pi Imager with Pi Privacy Gateway in its OS list...
echo In "Choose OS" pick "Pi Privacy Gateway". Double-check you pick your SD CARD under "Choose Storage".
start "" "%IMAGER%" --repo "%REPO%"
