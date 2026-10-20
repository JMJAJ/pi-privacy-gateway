# install-tasks.ps1 - run ONCE as administrator.
# Creates two scheduled tasks, "PGW VPN On" and "PGW VPN Off", that start/stop your WireGuard
# tunnel as SYSTEM, and lets your normal (non-admin) account trigger them. That is what lets
# the tray app toggle the VPN without a UAC prompt every time.
#
# Security: the scripts the tasks run live in C:\ProgramData\PiPrivacyGateway, writable only by
# SYSTEM/Administrators. (Never point a SYSTEM task at a script in a user-writable folder -
# any program running as you could edit it and gain full system rights.)
param([string]$TunnelName = 'pi-gateway', [string]$GatewayDns = '10.13.13.1')
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')) {
    throw 'Run this from an elevated PowerShell (Run as administrator).'
}
$dir = 'C:\ProgramData\PiPrivacyGateway'
$svc = "WireGuardTunnel`$$TunnelName"
if (-not (Get-Service -Name $svc -ErrorAction SilentlyContinue)) {
    throw "No WireGuard tunnel service '$svc'. Import your config in the WireGuard app as '$TunnelName' and activate it once first."
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null

@"
`$ErrorActionPreference = 'Continue'
`$log = '$dir\vpn.log'
function L(`$m) { "`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ON  `$m" | Out-File -Append -Encoding utf8 -LiteralPath `$log }
try {
    `$s = Get-Service -Name '$svc' -ErrorAction Stop
    if (`$s.Status -ne 'Running') { Start-Service -Name '$svc' -ErrorAction Stop }
    `$deadline = (Get-Date).AddSeconds(35)
    while ((Get-Date) -lt `$deadline) {
        `$a = Get-NetAdapter -Name '$TunnelName' -ErrorAction SilentlyContinue
        if (`$a -and `$a.Status -eq 'Up') { break }
        Start-Sleep -Milliseconds 500
    }
    Set-DnsClientServerAddress -InterfaceAlias '$TunnelName' -ServerAddresses '$GatewayDns'
    Clear-DnsClientCache
    L 'VPN ON'
} catch { L "FAILED: `$(`$_.Exception.Message)" }
"@ | Set-Content -Encoding UTF8 "$dir\on.ps1"

@"
`$log = '$dir\vpn.log'
try { Stop-Service -Name '$svc' -Force -ErrorAction Stop; "`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OFF VPN OFF" | Out-File -Append -Encoding utf8 -LiteralPath `$log }
catch { "`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') OFF FAILED: `$(`$_.Exception.Message)" | Out-File -Append -Encoding utf8 -LiteralPath `$log }
"@ | Set-Content -Encoding UTF8 "$dir\off.ps1"

# Folder: SYSTEM + Administrators full, Users read/execute. Inheritance flags on the folder only;
# files simply inherit (putting (OI)(CI) on files leaves them with an empty, unreadable ACL).
& icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
& icacls.exe "$dir\*" /reset /T /Q | Out-Null

$ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
foreach ($t in @(@('PGW VPN On', 'on.ps1'), @('PGW VPN Off', 'off.ps1'))) {
    $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\$($t[1])`""
    Register-ScheduledTask -TaskName $t[0] -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    # allow Authenticated Users to read + run (not modify) the task
    $sched = New-Object -ComObject Schedule.Service; $sched.Connect()
    $task = $sched.GetFolder('\').GetTask($t[0])
    $sd = $task.GetSecurityDescriptor(0xF)
    if ($sd -notmatch '\(A;;0x1200a9;;;AU\)') { $task.SetSecurityDescriptor($sd + '(A;;0x1200a9;;;AU)', 0) }
}
"Installed. Test without admin rights:  schtasks /run /tn ""PGW VPN On"""
