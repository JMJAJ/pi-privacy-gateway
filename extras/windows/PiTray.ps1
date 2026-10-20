# PiTray - Windows system tray control for Pi Privacy Gateway.
# Install: run install-tasks.ps1 once as administrator, then start PiTray.vbs (or put a shortcut
# to it in shell:startup). Edit the four settings below to match your setup.
# Left-click: menu. Double-click: dashboard. Icon colour: green = VPN on via WARP,
# magenta = VPN on via your provider (inside WARP), purple = VPN on via Tor, orange = VPN on but Pi not answering, grey = VPN off.
# Runs in Windows PowerShell 5.1 (STA). Keep this file ASCII-only.

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$TunnelName  = 'pi-gateway'                        # tunnel name as imported in the WireGuard app
$PiVpnUrl    = 'http://10.13.13.1'                 # gateway address inside the VPN
$PiLanUrl    = ''                                  # optional: http://<gateway LAN IP> for when the VPN is off
$EdgePath    = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$ServiceName = "WireGuardTunnel`$$TunnelName"

# single instance
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\PiTray', [ref]$created)
if (-not $created) { exit }

function New-DotIcon([string]$hex) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0b0f14'))), 1, 1, 30, 30)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))), 6, 6, 20, 20)
    $g.Dispose()
    [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$Icons = @{
    off  = New-DotIcon '#8b98a9'
    warp = New-DotIcon '#3fb950'
    tor  = New-DotIcon '#9085e9'
    proton = New-DotIcon '#d55181'
    bad  = New-DotIcon '#d29922'
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $Icons.off
$tray.Text = 'Pi Privacy'
$tray.Visible = $true

$menu     = New-Object System.Windows.Forms.ContextMenuStrip
$miStatus = $menu.Items.Add('Checking...'); $miStatus.Enabled = $false
$null     = $menu.Items.Add('-')
$miOn     = $menu.Items.Add('Turn VPN ON')
$miOff    = $menu.Items.Add('Turn VPN OFF')
$null     = $menu.Items.Add('-')
$miWarp   = $menu.Items.Add('Exit via WARP  (fast)')
$miProton = $menu.Items.Add('Exit via provider  (private, double hop)')
$miTor    = $menu.Items.Add('Exit via Tor  (anonymous, slow)')
$null     = $menu.Items.Add('-')
$miDash   = $menu.Items.Add('Open dashboard')
$miQuit   = $menu.Items.Add('Quit tray')
$tray.ContextMenuStrip = $menu

$script:state = @{ on = $false; mode = $null; reachable = $false; kill = $false; busy = $false }
$script:last = ''

function Get-PiState {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $on = $svc -and $svc.Status -eq 'Running'
    $mode = $null; $kill = $false; $reach = $false
    if ($on) {
        try {
            $r = Invoke-RestMethod -Uri "$PiVpnUrl/api/mode" -TimeoutSec 2
            $mode = $r.mode; $kill = [bool]$r.kill_switch; $reach = $true
            if ($r.provider) { $miProton.Text = "Exit via $($r.provider)  (private, double hop)"; $miProton.Visible = $true } else { $miProton.Visible = $false }
        } catch { }
    }
    @{ on = $on; mode = $mode; reachable = $reach; kill = $kill }
}

function Update-Ui {
    if ($script:state.busy) { return }
    $s = Get-PiState
    $script:state.on = $s.on; $script:state.mode = $s.mode
    $script:state.reachable = $s.reachable; $script:state.kill = $s.kill

    if (-not $s.on)            { $key = 'off';  $text = 'VPN OFF - normal internet' }
    elseif (-not $s.reachable) { $key = 'bad';  $text = 'VPN ON - Pi not answering' }
    elseif ($s.mode -eq 'tor') { $key = 'tor';  $text = 'VPN ON - exit via Tor' }
    elseif ($s.mode -eq 'provider') { $key = 'proton'; $text = 'VPN ON - exit via your provider' }
    else                       { $key = 'warp'; $text = 'VPN ON - exit via WARP' }
    if ($s.on -and $s.reachable -and -not $s.kill) { $text += ' (kill switch OFF!)' }

    $tray.Icon = $Icons[$key]
    $tray.Text = "Pi Privacy: $text"
    $miStatus.Text = $text
    $miOn.Enabled  = -not $s.on
    $miOff.Enabled = $s.on
    $miWarp.Enabled = $s.on -and $s.reachable
    $miTor.Enabled  = $s.on -and $s.reachable
    $miProton.Enabled = $s.on -and $s.reachable
    $miWarp.Checked = $s.mode -eq 'warp'
    $miTor.Checked  = $s.mode -eq 'tor'
    $miProton.Checked = $s.mode -eq 'provider'

    if ($script:last -and $script:last -ne $text) {
        $tray.ShowBalloonTip(2500, 'Pi Privacy', $text, 'Info')
    }
    $script:last = $text
}

function Invoke-VpnTask([string]$task) {
    Start-Process -FilePath "$env:WINDIR\System32\schtasks.exe" -ArgumentList '/run', '/tn', "`"$task`"" -WindowStyle Hidden
}

# Mode switches can take a few seconds (Tor readiness check), so run them off the UI thread.
$script:job = $null
function Set-ExitMode([string]$mode) {
    if ($script:state.busy) { return }
    $script:state.busy = $true
    $miStatus.Text = "Switching exit to $mode..."
    $tray.ShowBalloonTip(2000, 'Pi Privacy', "Switching exit to $mode...", 'Info')
    $ps = [powershell]::Create()
    $null = $ps.AddScript({
        param($url, $mode)
        try {
            $r = Invoke-RestMethod -Uri "$url/api/mode" -Method Post -TimeoutSec 150 `
                -Headers @{ 'X-Pi-Control' = '1' } -ContentType 'application/json' `
                -Body (@{ mode = $mode } | ConvertTo-Json)
            if ($r.ok) { 'ok' } else { 'failed' }
        } catch { "failed: $($_.Exception.Message)" }
    }).AddArgument($PiVpnUrl).AddArgument($mode)
    $script:job = @{ ps = $ps; handle = $ps.BeginInvoke(); mode = $mode }
}

function Open-Dashboard {
    $url = if ($script:state.on -or -not $PiLanUrl) { "$PiVpnUrl/dashboard" } else { "$PiLanUrl/dashboard" }
    if (Test-Path $EdgePath) { Start-Process -FilePath $EdgePath -ArgumentList "--app=$url" }
    else { Start-Process $url }
}

$miOn.add_Click({ Invoke-VpnTask 'PGW VPN On';  $miStatus.Text = 'Turning VPN on...' })
$miOff.add_Click({ Invoke-VpnTask 'PGW VPN Off'; $miStatus.Text = 'Turning VPN off...' })
$miWarp.add_Click({ Set-ExitMode 'warp' })
$miTor.add_Click({ Set-ExitMode 'tor' })
$miProton.add_Click({ Set-ExitMode 'provider' })
$miDash.add_Click({ Open-Dashboard })
$tray.add_DoubleClick({ Open-Dashboard })
$tray.add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        # show the same menu on left click
        $m = [System.Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'Instance,NonPublic')
        $m.Invoke($tray, $null)
    }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
    if ($script:job -and $script:job.handle.IsCompleted) {
        $res = ($script:job.ps.EndInvoke($script:job.handle) | Select-Object -First 1)
        $script:job.ps.Dispose()
        $msg = if ($res -eq 'ok') { "Exit is now $($script:job.mode). Reload open pages." } else { "Switch failed: $res" }
        $tray.ShowBalloonTip(3000, 'Pi Privacy', $msg, $(if ($res -eq 'ok') { 'Info' } else { 'Warning' }))
        $script:job = $null
        $script:state.busy = $false
        $script:last = ''   # the result balloon above already announced the change
    }
    Update-Ui
})

$miQuit.add_Click({
    $timer.Stop(); $tray.Visible = $false; $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

Update-Ui
$timer.Start()
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
