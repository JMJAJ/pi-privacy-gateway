#!/usr/bin/env python3
"""Pi Privacy Gateway - live dashboard backend (stdlib only).

Collectors run in background threads and keep an in-memory snapshot plus 5 minutes
of 1 s history; browsers get a live feed over Server-Sent Events. Sensitive data
(real ISP IP, DNS query log, traceroute, exit switching) is only served to VPN
clients or the host itself. When nobody has the dashboard open the expensive
checks slow down, so an unattended gateway stays quiet and cool.
"""
import base64
import glob
import ipaddress
import json
import os
import re
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.request
from collections import deque
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
CFG = "/config"
WG_DIR = "/etc/wireguard"
ADGUARD_URL = os.environ.get("ADGUARD_URL", "http://127.0.0.1:3000")
ADGUARD_USER = os.environ.get("ADGUARD_USER", "")
ADGUARD_PASS = os.environ.get("ADGUARD_PASSWORD", "")
PROVIDER_NAME = os.environ.get("PROVIDER_NAME", "Provider")
VPN_NET = ipaddress.ip_network(os.environ.get("VPN_SUBNET", "10.13.13.0/24"), strict=False)
VPN_IP = str(next(VPN_NET.hosts()))
PORT = int(os.environ.get("DASHBOARD_PORT", "80"))
WARP_FWMARK = 51820
HISTORY_LEN = 300
IDLE_AFTER = 90
# electricity cost shown next to the power estimate (each viewer can override it in the page)
PRICE_DEFAULTS = {"per_kwh": float(os.environ.get("PRICE_PER_KWH", "0.30")), "currency": os.environ.get("CURRENCY", "€")}

_lock = threading.Lock()
_state = {}
_history = {"t": deque(maxlen=HISTORY_LEN)}
_speed = {"running": False, "mbps": None, "ts": None, "error": None}
_mode_lock = threading.Lock()
EXIT_FILE = f"{CFG}/tor-exit"
_tor_lock = threading.Lock()
_tor_last = [0.0]


# Tor builds 3-relay circuits itself; the only safe knob is narrowing the exit's country (a smaller
# pool of exits means a bit less anonymity), so it is opt-in and the list is short and fixed.
TOR_COUNTRIES = {"at": "Austria", "ca": "Canada", "ch": "Switzerland", "cz": "Czechia", "de": "Germany", "fi": "Finland",
                 "fr": "France", "gb": "United Kingdom", "is": "Iceland", "jp": "Japan", "nl": "Netherlands",
                 "no": "Norway", "pl": "Poland", "ro": "Romania", "se": "Sweden", "us": "United States"}


def tor_exit_country():
    try:
        c = open(EXIT_FILE).read().strip().lower()
    except OSError:
        c = ""
    return c if c in TOR_COUNTRIES else ""


def tor_apply_exit():
    """Make Tor's ExitNodes match the saved choice (also after Tor restarts: SETCONF is not persistent)."""
    try:
        want = tor_exit_country()
        res = tor_control("GETCONF ExitNodes")
        cur = (res[0][0][4:].split("=", 1) + [""])[1].strip("{} ").lower() if res and res[0] else ""
        if cur == want:
            return True
        if want:
            tor_control("SETCONF ExitNodes={%s} StrictNodes=1" % want)
        else:
            tor_control("RESETCONF ExitNodes StrictNodes")
        tor_control("SIGNAL NEWNYM")
        return True
    except (OSError, ValueError, IndexError):
        return False


def _apply_exit_when_ready():
    for _ in range(30):
        time.sleep(2)
        if tor_apply_exit():
            return


# Snowflake bridge: switching takes minutes (Tor has to find a volunteer proxy), so it runs in the
# background and the page polls bridge_state()
_bridge = {"busy": False, "last": ""}


def bridge_state():
    st = run(["/usr/local/bin/pgw-exit", "tor-bridge", "status"], timeout=5).strip()
    return {"bridge": st or "off", "bridge_busy": _bridge["busy"], "bridge_msg": _bridge["last"]}


def bridge_switch(to):
    _bridge.update(busy=True, last="")
    try:
        r = subprocess.run(["/usr/local/bin/pgw-exit", "tor-bridge", to], capture_output=True, text=True, timeout=600)
        lines = (r.stdout + r.stderr).strip().splitlines()
        _bridge["last"] = lines[-1] if lines else ""
    except (OSError, subprocess.SubprocessError) as e:
        _bridge["last"] = str(e)[:200]
    finally:
        _bridge["busy"] = False


def tor_restart():
    """Stop Tor (at most once every 15 s); supervisord starts it again. The kill switch stays closed meanwhile."""
    if not _tor_lock.acquire(blocking=False):
        return False, "wait"
    try:
        if time.time() - _tor_last[0] < 15:
            return False, "wait"
        _tor_last[0] = time.time()
        r = subprocess.run(["pkill", "-TERM", "-x", "tor"], capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            threading.Thread(target=_apply_exit_when_ready, daemon=True).start()
        return r.returncode == 0, "Tor is not running" if r.returncode else ""
    except (OSError, subprocess.SubprocessError) as e:
        return False, str(e)[:200]
    finally:
        _tor_lock.release()
_trace_lock = threading.Lock()
_trace_cache = {}
_last_view = 0.0


# ---------------------------------------------------------------- helpers
def run(cmd, timeout=8):
    try:
        p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout)
        return p.stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def read(path, default=""):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return default


def put(**kw):
    with _lock:
        _state.update(kw)


def get(name, default=None):
    with _lock:
        return _state.get(name, default)


def viewing():
    return time.time() - _last_view < IDLE_AFTER


def hist_push(t, values):
    with _lock:
        _history["t"].append(t)
        for k, v in values.items():
            _history.setdefault(k, deque(maxlen=HISTORY_LEN)).append(v)


def loop(interval, fn, idle_interval=None):
    def worker():
        last = 0.0
        while True:
            every = interval if (idle_interval is None or viewing()) else idle_interval
            if time.time() - last >= every:
                last = time.time()
                try:
                    fn()
                except Exception as exc:  # noqa: BLE001 - a collector must never die
                    put(**{f"err_{fn.__name__}": str(exc)})
            time.sleep(min(interval, 1.0))

    threading.Thread(target=worker, daemon=True, name=fn.__name__).start()


def adguard(path):
    auth = base64.b64encode(f"{ADGUARD_USER}:{ADGUARD_PASS}".encode()).decode()
    req = urllib.request.Request(ADGUARD_URL + path, headers={"Authorization": "Basic " + auth})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.load(resp)


def peers_by_ip():
    """{"10.13.13.2/32": "phone", ...} from the '# Name:' comments pgw writes into wg1.conf."""
    names, name = {}, None
    for line in read(f"{WG_DIR}/wg1.conf").splitlines():
        if line.startswith("# Name: "):
            name = line[8:].strip()
        elif line.startswith("AllowedIPs") and name:
            names[line.split("=", 1)[1].strip()] = name
            name = None
    return names


def physical_ifaces():
    out = []
    for p in sorted(glob.glob("/sys/class/net/*/device")):
        name = p.split("/")[4]
        wireless = os.path.isdir(f"/sys/class/net/{name}/wireless") or os.path.isdir(f"/sys/class/net/{name}/phy80211")
        out.append({"name": name, "wireless": wireless})
    return out


def default_route():
    out = run("ip -4 route show default table main | head -n1")
    dev = re.search(r"dev (\S+)", out)
    via = re.search(r"via (\S+)", out)
    return (dev.group(1) if dev else None), (via.group(1) if via else None)


def iface_labels():
    labels = {"wg1": "VPN server · wg1", "wg0": "WARP tunnel · wg0"}
    if os.path.exists(f"{WG_DIR}/wg2.conf"):
        labels["wg2"] = f"{PROVIDER_NAME} tunnel · wg2"
    for i in physical_ifaces():
        labels[i["name"]] = ("Wi-Fi · " if i["wireless"] else "Ethernet · ") + i["name"]
    return labels


HARDWARE = read("/proc/device-tree/model").strip("\x00") or read("/sys/class/dmi/id/product_name") or "Linux host"
IS_PI4 = "Raspberry Pi 4" in HARDWARE


# ------------------------------------------------------- fast (1 s) collector
_prev = {}


def read_netdev():
    out = {}
    for line in read("/proc/net/dev").splitlines()[2:]:
        name, rest = line.split(":", 1)
        f = rest.split()
        out[name.strip()] = (int(f[0]), int(f[8]))
    return out


def read_cpu():
    cores = {}
    for line in read("/proc/stat").splitlines():
        if line.startswith("cpu"):
            f = line.split()
            vals = list(map(int, f[1:8]))
            cores[f[0]] = (sum(vals), vals[3] + vals[4])
    return cores


def wg_dump(iface, names=None):
    lines = [ln for ln in run(["wg", "show", iface, "dump"]).splitlines() if ln.strip()]
    if not lines:
        return {"up": False, "peers": []}
    res = {"up": True, "peers": []}
    now = int(time.time())
    names = names or {}
    for line in lines[1:]:
        f = line.split("\t")
        if len(f) < 8:
            continue
        hs, rx, tx = int(f[4] or 0), int(f[5] or 0), int(f[6] or 0)
        res["peers"].append({
            "name": names.get(f[3], f[3].split("/")[0]), "allowed": f[3],
            "endpoint": None if f[2] == "(none)" else f[2],
            "handshake_age": now - hs if hs else None, "rx": rx, "tx": tx,
        })
    return res


def power_estimate(cpu_util, rates):
    """Raspberry Pi 4 only: model-based estimate (it has no power sensor).
    Board idle ~2.7 W incl. onboard Wi-Fi, +~3.2 W at full load on 4 cores @1.8 GHz,
    plus ~0.6-2.4 W for a USB Wi-Fi adapter depending on traffic."""
    if not IS_PI4:
        return None
    freq = get("arm_hz") or 1.8e9
    cpu_w = 3.2 * (cpu_util / 100.0) * (freq / 1.8e9)
    usb_wifi = [i["name"] for i in physical_ifaces() if i["wireless"] and i["name"].startswith("wlx")]
    usb_w = 0.0
    for n in usb_wifi:
        r = rates.get(n, {})
        usb_w += 0.6 + min(1.8, (r.get("rx_bps", 0) + r.get("tx_bps", 0)) / 1e8 * 1.8)
    parts = [{"name": "Board + RAM", "w": 2.35}, {"name": "CPU load", "w": round(cpu_w, 2)},
             {"name": "Onboard Wi-Fi", "w": 0.35}]
    if usb_wifi:
        parts.insert(2, {"name": "USB Wi-Fi adapter", "w": round(usb_w, 2)})
    total = sum(p["w"] for p in parts)
    return {"total_w": round(total, 2), "parts": parts, "amps_5v": round(total / 5.1, 2), "estimated": True}


def fast():
    now = time.time()
    net, cpu = read_netdev(), read_cpu()
    labels = iface_labels()
    wg1 = wg_dump("wg1", peers_by_ip())
    rates, cpu_pct, peer_rates = {}, {}, {}
    if "net" in _prev:
        dt = now - _prev["t"]
        for ifc in labels:
            if ifc in net and ifc in _prev["net"]:
                rates[ifc] = {"rx_bps": max(0, (net[ifc][0] - _prev["net"][ifc][0]) * 8 / dt),
                              "tx_bps": max(0, (net[ifc][1] - _prev["net"][ifc][1]) * 8 / dt)}
        for core, (tot, idle) in cpu.items():
            pt, pi = _prev["cpu"].get(core, (tot, idle))
            cpu_pct[core] = round(100 * (1 - (idle - pi) / max(1, tot - pt)), 1)
        for p in wg1["peers"]:
            old = _prev["peers"].get(p["allowed"])
            if old:  # gateway "tx" to a peer = that device's download
                peer_rates[p["name"]] = {"down_bps": max(0, (p["tx"] - old[1]) * 8 / dt),
                                         "up_bps": max(0, (p["rx"] - old[0]) * 8 / dt)}
    _prev.update(t=now, net=net, cpu=cpu, peers={p["allowed"]: (p["rx"], p["tx"]) for p in wg1["peers"]})
    temp = int(read("/sys/class/thermal/thermal_zone0/temp", "0") or 0) / 1000.0 or None
    power = power_estimate(cpu_pct.get("cpu", 0), rates)
    put(rates=rates, cpu=cpu_pct, wg1=wg1, peer_rates=peer_rates, temp_c=temp, power=power, ts=now,
        ifaces=[{"key": k, "label": v} for k, v in labels.items()])
    if rates:
        vals = {"cpu": cpu_pct.get("cpu", 0), "temp": temp, "power": power["total_w"] if power else None,
                "vpn_down": sum(r["down_bps"] for r in peer_rates.values()),
                "vpn_up": sum(r["up_bps"] for r in peer_rates.values())}
        for ifc, r in rates.items():
            vals[f"{ifc}_rx"] = round(r["rx_bps"])
            vals[f"{ifc}_tx"] = round(r["tx_bps"])
        hist_push(round(now), vals)


# ----------------------------------------------------- medium (5 s) collector
def radio(iface):
    link = run(["iw", "dev", iface, "link"])
    info = run(["iw", "dev", iface, "info"])
    st = run(["iw", "dev", iface, "station", "dump"])

    def g(pat, text, cast=str):
        m = re.search(pat, text)
        return cast(m.group(1)) if m else None

    return {
        "iface": iface, "wireless": True, "connected": "Connected to" in link,
        "ssid": g(r"SSID: (.+)", link), "freq": g(r"freq: ([\d.]+)", link, float),
        "channel": g(r"channel (\d+)", info, int), "width": g(r"width: (\d+ MHz)", info),
        "signal_dbm": g(r"signal: (-?\d+) dBm", link, int),
        "tx_mbit": g(r"tx bitrate: ([\d.]+) MBit/s", link, float), "rx_mbit": g(r"rx bitrate: ([\d.]+) MBit/s", link, float),
        "tx_mode": g(r"tx bitrate: [\d.]+ MBit/s (.+)", link), "txpower_dbm": g(r"txpower ([\d.]+) dBm", info, float),
        "tx_retries": g(r"tx retries:\s+(\d+)", st, int), "tx_failed": g(r"tx failed:\s+(\d+)", st, int),
        "power_save": (run(["iw", "dev", iface, "get", "power_save"]).replace("Power save: ", "") or None),
    }


def link_info(iface, wireless):
    d = radio(iface) if wireless else {"iface": iface, "wireless": False,
                                         "speed": read(f"/sys/class/net/{iface}/speed") or None}
    d["state"] = read(f"/sys/class/net/{iface}/operstate", "unknown")
    d["ip"] = run(f"ip -4 -o addr show {iface} | awk '{{print $4}}' | head -n1") or None
    d["mac"] = read(f"/sys/class/net/{iface}/address") or None
    return d


def undervoltage():
    """Raspberry Pi firmware exposes an under-voltage alarm as hwmon 'rpi_volt'."""
    for h in glob.glob("/sys/class/hwmon/hwmon*"):
        if read(f"{h}/name") == "rpi_volt":
            return read(f"{h}/in0_lcrit_alarm") == "1"
    return None


_uv = {"events": 0, "last": None, "prev": False}


def supply_health():
    """Under-voltage now, plus how many dips we have seen since the dashboard started (the Pi 4 has no
    current sensor: this flag is the only real signal about the power supply)."""
    now = undervoltage()
    if now and not _uv["prev"]:
        _uv["events"] += 1
    if now:
        _uv["last"] = time.time()
    _uv["prev"] = bool(now)
    return {"now": now, "events": _uv["events"], "last_ts": _uv["last"]}


def medium():
    mem = {}
    for line in read("/proc/meminfo").splitlines():
        k, v = line.split(":", 1)
        mem[k] = int(v.split()[0])
    st = os.statvfs("/config")
    dev, gw = default_route()
    arm_hz = int(read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "0") or 0) * 1000
    pix = []
    for line in run(["iptables", "-L", "PIX_FWD", "-v", "-x", "-n"]).splitlines()[2:]:
        f = line.split()
        if len(f) >= 8:
            pix.append({"pkts": int(f[0]), "target": f[2], "in": f[5], "out": f[6]})
    put(
        arm_hz=arm_hz,
        system={
            "model": HARDWARE, "kernel": os.uname().release,
            "uptime_s": int(float(read("/proc/uptime", "0 0").split()[0])),
            "load": read("/proc/loadavg", "0 0 0").split()[:3], "cpu_mhz": round(arm_hz / 1e6) or None,
            "undervoltage": undervoltage(), "supply": supply_health(),
            "mem_total_mb": mem.get("MemTotal", 0) // 1024,
            "mem_used_mb": (mem.get("MemTotal", 0) - mem.get("MemAvailable", 0)) // 1024,
            "disk_total_gb": round(st.f_blocks * st.f_frsize / 1e9, 1),
            "disk_used_gb": round((st.f_blocks - st.f_bfree) * st.f_frsize / 1e9, 1),
            "conntrack": int(read("/proc/sys/net/netfilter/nf_conntrack_count", "0") or 0),
            "conntrack_max": int(read("/proc/sys/net/netfilter/nf_conntrack_max", "0") or 0),
        },
        links=[link_info(i["name"], i["wireless"]) for i in physical_ifaces()],
        uplink=dev, gateway=gw,
        wg0=wg_dump("wg0"), wg2=wg_dump("wg2"),
        provider={"configured": os.path.exists(f"{WG_DIR}/wg2.conf"), "name": PROVIDER_NAME},
        killswitch={"armed": subprocess.run(["iptables", "-C", "FORWARD", "-j", "PIX_FWD"], capture_output=True).returncode == 0,
                    "rejected_pkts": sum(r["pkts"] for r in pix if r["target"] == "REJECT")},
        mode=quick_mode(),
    )


# --------------------------------------------------- latency (10 s) collector
def ping_ms(host, mark=None, iface=None, count=3):
    if not host:
        return {"ms": None, "loss": 100.0}
    cmd = ["ping", "-n", "-q", "-c", str(count), "-i", "0.2", "-W", "1"]
    if mark:
        cmd += ["-m", str(mark)]
    if iface:
        cmd += ["-I", iface]
    out = run(cmd + [host], timeout=6)
    m = re.search(r"= [\d.]+/([\d.]+)/", out)
    loss = re.search(r"([\d.]+)% packet loss", out)
    return {"ms": float(m.group(1)) if m else None, "loss": float(loss.group(1)) if loss else 100.0}


def latency():
    _, gw = default_route()
    warp_ep = ((get("wg0") or {}).get("peers") or [{}])[0].get("endpoint") or ""
    tor_out = run(["curl", "-s", "-o", "/dev/null", "-w", "%{time_appconnect}", "--max-time", "10",
                   "--socks5-hostname", "127.0.0.1:9050", "https://1.1.1.1/"], timeout=12)
    try:
        tor_ms = round(float(tor_out) * 1000, 1) or None
    except ValueError:
        tor_ms = None
    put(latency={
        "router": ping_ms(gw, WARP_FWMARK),
        "isp_internet": ping_ms("1.1.1.1", WARP_FWMARK),
        "warp_edge": ping_ms(warp_ep.rsplit(":", 1)[0] or None, WARP_FWMARK),
        "via_warp": ping_ms("1.1.1.1"),
        "via_provider": ping_ms("1.1.1.1", iface="wg2") if os.path.exists(f"{WG_DIR}/wg2.conf") else None,
        "via_tor_connect_ms": tor_ms,
    })


# ------------------------------------------------------ slow (30 s) collector
def trace_1111(extra):
    out = run(["curl", "-4", "-s", "-D", "-", "--max-time", "8"] + extra + ["https://1.1.1.1/cdn-cgi/trace"], timeout=12)
    d = dict(ln.split("=", 1) for ln in out.splitlines() if "=" in ln and ":" not in ln.split("=", 1)[0])
    date = re.search(r"^date: (.+)$", out, re.I | re.M)
    return {"ip": d.get("ip"), "colo": d.get("colo"), "loc": d.get("loc"), "warp": d.get("warp"), "ok": bool(d),
            "date": date.group(1).strip() if date else None}


def tor_control(*cmds):
    cookie = open("/run/tor/control.authcookie", "rb").read().hex()
    s = socket.create_connection(("127.0.0.1", 9051), timeout=5)
    f = s.makefile("rwb")
    out = []
    for c in [f"AUTHENTICATE {cookie}"] + list(cmds):
        f.write((c + "\r\n").encode())
        f.flush()
        lines = []
        data = False   # inside a "250+key=" block, which ends with a lone "."
        while True:
            line = f.readline().decode(errors="replace")
            if not line:
                break
            line = line.rstrip("\r\n")
            lines.append(line)
            if data:
                data = line != "."
            elif line[:4] == "250+":
                data = True
            # circuit lines start with their numeric id ("123 BUILT ..."), so only a reply line ends here
            elif len(line) >= 4 and line[:3].isdigit() and line[3] == " ":
                break
        out.append(lines)
    s.close()
    return out[1:]


def tor_info():
    res = tor_control("GETINFO status/bootstrap-phase", "GETINFO circuit-status", "GETINFO traffic/read", "GETINFO traffic/written")
    boot = re.search(r"PROGRESS=(\d+)", " ".join(res[0]))
    circuits = [ln for ln in res[1] if " BUILT " in ln and "PURPOSE=GENERAL" in ln]
    path = []
    if circuits:
        for i, hop in enumerate(circuits[-1].split(" BUILT ")[1].split(" ")[0].split(",")):
            fp, _, nick = hop.lstrip("$").partition("~")
            r = next((ln for ln in tor_control(f"GETINFO ns/id/{fp}")[0] if ln.startswith("r ")), "").split()
            ip = r[6] if len(r) > 6 else None  # "r <nick> <id> <digest> <date> <time> <IP> ..."
            cc = None
            if ip:
                c = tor_control(f"GETINFO ip-to-country/{ip}")[0][0]
                cc = c.split("=")[-1].upper() if "=" in c else None
            path.append({"role": ["Guard", "Middle", "Exit"][i] if i < 3 else f"Hop {i + 1}", "nick": nick, "ip": ip, "country": cc})
    val = lambda r: int(r[0].split("=")[-1]) if "=" in r[0] else None  # noqa: E731
    return {"bootstrap": int(boot.group(1)) if boot else None, "circuits": len(circuits), "path": path,
            "read_bytes": val(res[2]), "written_bytes": val(res[3])}


_tor_seen = {"ip": None, "misses": 0}


def slow():
    dev, _ = default_route()
    warp = trace_1111([])
    isp = trace_1111(["--interface", dev]) if dev else {}
    if isp.get("ip"):
        isp["asn"], isp["as_name"] = asn_of(isp["ip"])
    provider = trace_1111(["--interface", "wg2"]) if os.path.exists(f"{WG_DIR}/wg2.conf") else {}
    tor_exit = None
    # through a Snowflake bridge Tor can be slow: allow 30 s, and only report Tor as down after two misses
    try:
        tor_exit = json.loads(run(["curl", "-s", "--max-time", "30", "--socks5-hostname", "127.0.0.1:9050",
                                   "https://check.torproject.org/api/ip"], timeout=35)).get("IP")
    except ValueError:
        pass
    if tor_exit:
        _tor_seen.update(ip=tor_exit, misses=0)
    else:
        _tor_seen["misses"] += 1
        if _tor_seen["misses"] < 2:
            tor_exit = _tor_seen["ip"]
    try:
        tor = tor_info()
    except Exception as exc:  # noqa: BLE001
        tor = {"error": str(exc), "path": []}
    tor["exit_ip"] = tor_exit
    # clock check (Tor refuses to work with a wrong clock)
    clock = None
    if warp.get("date"):
        try:
            clock = round(time.time() - parsedate_to_datetime(warp["date"]).timestamp(), 1)
        except (TypeError, ValueError):
            pass
    try:
        status, stats, dnsinfo = adguard("/control/status"), adguard("/control/stats"), adguard("/control/dns_info")
        q, b = stats.get("num_dns_queries", 0), stats.get("num_blocked_filtering", 0)
        dns = {
            "ok": True, "protection": bool(status.get("protection_enabled")), "version": status.get("version"),
            "queries": q, "blocked": b, "blocked_pct": round(100.0 * b / max(1, q), 1),
            "avg_ms": round(float(stats.get("avg_processing_time", 0)) * 1000, 1),
            "top_blocked": [{"domain": next(iter(i)), "count": next(iter(i.values()))} for i in (stats.get("top_blocked_domains") or [])[:8]],
            "upstreams": dnsinfo.get("upstream_dns", []), "dnssec": dnsinfo.get("dnssec_enabled"),
            "queries_series": stats.get("dns_queries", [])[-24:], "blocked_series": stats.get("blocked_filtering", [])[-24:],
        }
    except Exception as exc:  # noqa: BLE001
        dns = {"ok": False, "error": str(exc)}
    put(exits={"warp": warp, "isp": isp, "provider": provider, "tor_ip": tor_exit}, tor=tor, dns=dns, clock_offset_s=clock)


def components():
    def listening(port, proto="t"):
        return f":{port} " in run(["ss", f"-ln{proto}H"]) + " "
    wg = {i: os.path.exists(f"/sys/class/net/{i}") for i in ("wg0", "wg1", "wg2")}
    comp = {"VPN server (wg1)": wg["wg1"], "WARP tunnel (wg0)": wg["wg0"]}
    if os.path.exists(f"{WG_DIR}/wg2.conf"):
        comp[f"{PROVIDER_NAME} tunnel (wg2)"] = wg["wg2"]
    comp.update({"Tor": listening(9050), "Tor transparent proxy": listening(9040),
                 "AdGuard DNS": listening(53, "u"), "AdGuard admin": listening(3000),
                 "Kill switch": (get("killswitch") or {}).get("armed", False)})
    if os.environ.get("THREAT_LISTS", "on") == "on":
        comp["Threat blocklists"] = "PGW_THREAT" in run(["iptables", "-S", "PIX_FWD"])
    if IDS_ON:
        comp["Traffic inspection (IDS)"] = "NFQUEUE" in run(["iptables", "-t", "mangle", "-S", "PGW_IDS"])
    listen = []
    for line in run(["ss", "-H", "-tuln"]).splitlines():
        f = line.split()
        if len(f) >= 5 and not f[4].startswith(("127.", "[::1]")):
            listen.append({"proto": f[0], "addr": f[4]})
    put(components=comp, listening=listen)


# ------------------------------------------------------------ threat protection
IDS_ON = os.environ.get("IDS", "off") == "on"
IDS_RULES = "/config/ids/suricata/rules/suricata.rules"


def ids_state():
    """Live connections + threat alerts from pgw-idsd, plus engine and blocklist status."""
    try:
        with open("/run/pgw/ids/state.json") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        d = {"connections": [], "alerts": [], "stats": {}, "dyn_blocked": []}

    def num(path):
        try:
            return int(read(path))
        except ValueError:
            return None
    rules = rules_updated = None
    if IDS_ON:
        try:
            with open(IDS_RULES) as fh:
                rules = sum(1 for line in fh if line.startswith("alert"))
            rules_updated = int(os.path.getmtime(IDS_RULES))
        except OSError:
            pass
    d["status"] = {"enabled": IDS_ON, "lists_enabled": os.environ.get("THREAT_LISTS", "on") == "on",
                   "engine": IDS_ON and bool(run(["pgrep", "-f", "^suricata -c"], timeout=5)),
                   "inline": "NFQUEUE" in run(["iptables", "-t", "mangle", "-S", "PGW_IDS"], timeout=5),
                   "rules": rules, "rules_updated": rules_updated,
                   "list_entries": num("/config/ids/lists-count"), "lists_updated": num("/config/ids/lists-updated")}
    return d


# ------------------------------------------------------------ on-demand items
TARGET_RE = re.compile(r"^(?=.{1,253}$)([A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$")
SO_MARK = 36
_asn_cache = {}


def asn_of(ip):
    """Origin AS via Team Cymru DNS (resolved through AdGuard, so it follows the exit mode)."""
    if ip in _asn_cache:
        return _asn_cache[ip]
    a = ipaddress.ip_address(ip)
    if a.is_private or a.is_loopback or a.is_link_local or a in ipaddress.ip_network("100.64.0.0/10"):
        _asn_cache[ip] = ("private", None)
        return _asn_cache[ip]
    txt = run(["dig", "+short", "+time=2", "+tries=1", "TXT", ".".join(reversed(ip.split("."))) + ".origin.asn.cymru.com"], timeout=4).strip('"')
    asn = txt.split("|")[0].strip().split(" ")[0] if txt else None
    name = None
    if asn:
        t2 = run(["dig", "+short", "+time=2", "+tries=1", "TXT", f"AS{asn}.asn.cymru.com"], timeout=4).strip('"')
        name = t2.split("|")[-1].strip() if t2 else None
    _asn_cache[ip] = (f"AS{asn}" if asn else None, name)
    return _asn_cache[ip]


def _icmp_checksum(data):
    if len(data) % 2:
        data += b"\0"
    s = sum((data[i] << 8) + data[i + 1] for i in range(0, len(data), 2))
    s = (s >> 16) + (s & 0xFFFF)
    s += s >> 16
    return (~s) & 0xFFFF


def _icmp_packet(ident, seq):
    payload = b"pgw-trace" + b"\0" * 23
    hdr = bytes([8, 0, 0, 0]) + ident.to_bytes(2, "big") + seq.to_bytes(2, "big")
    return bytes([8, 0]) + _icmp_checksum(hdr + payload).to_bytes(2, "big") + hdr[4:] + payload


def _icmp_trace(dst, mark, max_hops=20, rounds=4, gap=0.25, wait=1.5):
    """mtr-style probe: each round sends one echo per TTL; replies and time-exceeded
    errors are matched back to (ttl, round) through the ICMP sequence number."""
    ident = os.getpid() & 0xFFFF
    s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
    if mark:
        s.setsockopt(socket.SOL_SOCKET, SO_MARK, mark)
    s.setblocking(False)
    sent, hops, final_ttl, rnd, next_send = {}, {}, None, 0, time.time()
    deadline = time.time() + rounds * gap + wait
    while time.time() < deadline:
        if rnd < rounds and time.time() >= next_send:
            for ttl in range(1, max_hops + 1):
                if final_ttl and ttl > final_ttl:
                    break
                seq = rnd * 100 + ttl
                s.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, ttl)
                sent[seq] = time.time()
                try:
                    s.sendto(_icmp_packet(ident, seq), (dst, 0))
                except OSError:
                    pass
            rnd += 1
            next_send = time.time() + gap
        try:
            data, addr = s.recvfrom(1500)
        except BlockingIOError:
            time.sleep(0.005)
            continue
        now, ihl = time.time(), (data[0] & 0x0F) * 4
        typ = data[ihl]
        if typ == 0:
            o = ihl
        elif typ in (11, 3):
            o = ihl + 8 + (data[ihl + 8] & 0x0F) * 4
        else:
            continue
        pid, seq = int.from_bytes(data[o + 4:o + 6], "big"), int.from_bytes(data[o + 6:o + 8], "big")
        if pid != ident or seq not in sent:
            continue
        ttl = seq % 100
        hops.setdefault(ttl, {"host": addr[0], "rtts": []})["rtts"].append((now - sent[seq]) * 1000)
        if typ == 0 and (final_ttl is None or ttl < final_ttl):
            final_ttl = ttl
    s.close()
    out = []
    for ttl in range(1, (final_ttl or (max(hops) if hops else 0)) + 1):
        h = hops.get(ttl)
        if not h:
            out.append({"hop": ttl, "host": None, "loss": 100.0})
            continue
        r = h["rtts"]
        asn, asname = asn_of(h["host"])
        out.append({"hop": ttl, "host": h["host"], "asn": asn, "as_name": asname,
                    "loss": round(100.0 * (1 - len(r) / rounds), 1), "last": round(r[-1], 1),
                    "avg": round(sum(r) / len(r), 1), "best": round(min(r), 1), "worst": round(max(r), 1)})
    return out, final_ttl is not None


def traceroute(target, path):
    """path=warp: normal route. path=isp: probes carry WARP's fwmark, so they skip the
    WARP routing rule and show the real ISP route (probes come from the gateway)."""
    key = (target, path)
    with _lock:
        c = _trace_cache.get(key)
        if c and time.time() - c[0] < 3:
            return c[1]
    if not _trace_lock.acquire(timeout=20):
        return {"error": "another trace is running"}
    try:
        try:
            dst = socket.getaddrinfo(target, None, socket.AF_INET)[0][4][0]
        except OSError:
            return {"error": f"cannot resolve {target}"}
        hubs, reached = _icmp_trace(dst, WARP_FWMARK if path == "isp" else 0)
        res = {"target": target, "ip": dst, "path": path, "hubs": hubs, "reached": reached, "ts": int(time.time())}
    finally:
        _trace_lock.release()
    with _lock:
        _trace_cache[key] = (time.time(), res)
    return res


def querylog(limit=60):
    names = {k.split("/")[0]: v for k, v in peers_by_ip().items()}
    names["127.0.0.1"] = "gateway"
    rows = []
    for q in adguard(f"/control/querylog?limit={limit * 3}").get("data", []):
        name = (q.get("question") or {}).get("name") or ""
        if name.endswith(".asn.cymru.com"):  # the dashboard's own traceroute lookups
            continue
        reason = q.get("reason", "")
        rows.append({"time": q.get("time"), "client": names.get(q.get("client"), q.get("client")), "domain": name,
                     "type": (q.get("question") or {}).get("type"),
                     "blocked": reason.startswith("Filtered") and "NotFiltered" not in reason,
                     "ms": round(float(q.get("elapsedMs") or 0), 1), "cached": q.get("cached")})
    return rows[:limit]


_quick = {}


def quick_mode():
    try:   # cached until the file changes (also when the CLI switches the mode)
        stamp = os.stat(f"{CFG}/mode").st_mtime_ns
    except OSError:
        stamp = None
    hit = _quick.get("mode")
    if hit and stamp is not None and hit[0] == stamp:
        return hit[1]
    m = read(f"{CFG}/mode", "warp")
    m = m if m in ("warp", "provider", "tor") else "warp"
    _quick["mode"] = (stamp, m)
    return m


def tor_via():
    return "provider" if read(f"{CFG}/tor-via", "").strip() == "provider" and os.path.exists(f"{WG_DIR}/wg2.conf") else "warp"


def set_mode(mode):
    with _mode_lock:
        out = run(["/usr/local/bin/pgw-exit", "set", mode], timeout=150)
    _quick.pop("mode", None)
    medium()
    threading.Thread(target=slow, daemon=True).start()
    return out


# ------------------------------------------------------------------ devices
# Managing devices hands out VPN keys, so it needs a VPN client - and, if ADMIN_IPS is set,
# one of those specific devices (e.g. ADMIN_IPS=10.13.13.2 for your PC only).
ADMIN_IPS = {x.strip() for x in os.environ.get("ADMIN_IPS", "").split(",") if x.strip()}
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def device_modes():
    out = {}
    for line in read(f"{CFG}/device-modes").splitlines():
        f = line.split()
        if len(f) == 2:
            out[f[0]] = f[1]
    return out


def devices():
    names = peers_by_ip()
    modes = device_modes()
    live = {p["allowed"]: p for p in wg_dump("wg1", names)["peers"]}
    rows = []
    for allowed, name in names.items():
        ip, p = allowed.split("/")[0], live.get(allowed, {})
        rows.append({"name": name, "ip": ip, "exit": modes.get(ip, "default"), "handshake_age": p.get("handshake_age"),
                     "endpoint": p.get("endpoint"), "rx": p.get("rx"), "tx": p.get("tx")})
    return sorted(rows, key=lambda r: ipaddress.ip_address(r["ip"]))


def peer_bundle(name):
    """The device's config + QR code. Contains its private key: only ever sent to an admin over the VPN."""
    conf_path, png_path = f"{CFG}/peers/{name}.conf", f"{CFG}/peers/{name}.png"
    if not os.path.exists(conf_path):
        return None
    with open(png_path, "rb") as fh:
        qr = "data:image/png;base64," + base64.b64encode(fh.read()).decode()
    return {"name": name, "conf": read(conf_path), "qr": qr}


def pgw(*args, timeout=150):
    p = subprocess.run(["/usr/local/bin/pgw", *args], capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


# ------------------------------------------------------------------ history (30 days, 1 point per minute)
HIST_DB = f"{CFG}/history.db"
RANGES = {"1h": (3600, 60), "24h": (86400, 600), "7d": (604800, 3600), "30d": (2592000, 14400)}  # span, bucket


def _db():
    conn = sqlite3.connect(HIST_DB, timeout=5)
    conn.execute("CREATE TABLE IF NOT EXISTS h (t INTEGER PRIMARY KEY, cpu REAL, temp REAL, power REAL, "
                 "down REAL, up REAL, blocked_pct REAL, devices INTEGER, mode TEXT)")
    return conn


def history_sample():
    """Average the last minute of live samples into one row; keep 30 days (~43k rows, a few MB)."""
    with _lock:
        t = list(_history["t"])
        cols = {k: list(_history.get(k, [])) for k in ("cpu", "temp", "power", "vpn_down", "vpn_up")}
    now = int(time.time())
    idx = [i for i, ts in enumerate(t) if ts > now - 60]
    if not idx:
        return

    def avg(k):
        vals = [cols[k][i] for i in idx if i < len(cols[k]) and cols[k][i] is not None]
        return round(sum(vals) / len(vals), 2) if vals else None
    online = sum(1 for p in (get("wg1") or {}).get("peers", []) if (p.get("handshake_age") or 9999) < 180)
    with _db() as conn:
        conn.execute("INSERT OR REPLACE INTO h VALUES (?,?,?,?,?,?,?,?,?)",
                     (now - now % 60, avg("cpu"), avg("temp"), avg("power"), avg("vpn_down"), avg("vpn_up"),
                      (get("dns") or {}).get("blocked_pct"), online, quick_mode()))
        conn.execute("DELETE FROM h WHERE t < ?", (now - RANGES["30d"][0],))


def history_query(rng):
    span, bucket = RANGES[rng]
    with _db() as conn:
        rows = conn.execute(
            "SELECT (t / ?) * ? AS b, AVG(cpu), AVG(temp), AVG(power), AVG(down), MAX(down), AVG(up), "
            "AVG(blocked_pct), MAX(devices) FROM h WHERE t >= ? GROUP BY b ORDER BY b",
            (bucket, bucket, int(time.time()) - span)).fetchall()
    keys = ("t", "cpu", "temp", "power", "down", "down_peak", "up", "blocked_pct", "devices")
    return {"range": rng, "span": span, "bucket": bucket, **{k: [r[i] for r in rows] for i, k in enumerate(keys)}}


# ------------------------------------------------------------------ leak test
def dns_seen(token, client_ip):
    """Did a lookup containing `token` from this device reach AdGuard? If not, the device's DNS
    goes somewhere else (browser DNS-over-HTTPS, Android Private DNS...) = a DNS leak."""
    try:
        data = adguard(f"/control/querylog?limit=200&search={token}").get("data", [])
    except Exception:  # noqa: BLE001
        return None
    return any(token in ((q.get("question") or {}).get("name") or "") and q.get("client") == client_ip for q in data)


def expected_exit(client_ip):
    """Which exit this device should be using right now, and that exit's public IP."""
    mode = device_modes().get(client_ip) or quick_mode()
    if mode == "provider" and os.path.exists("/run/pgw/failover"):
        mode = "warp"
    ex = get("exits") or {}
    ip = {"warp": (ex.get("warp") or {}).get("ip"), "provider": (ex.get("provider") or {}).get("ip"),
          "tor": ex.get("tor_ip")}.get(mode)
    return {"mode": mode, "ip": ip}


# ----------------------------------------------------------------- snapshot
_MAC_RE = re.compile(r"\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b")


def _scrub(o):
    """For viewers outside the VPN: drop what only the owner needs - Wi-Fi names, MAC addresses,
    router/LAN topology and listening ports (on a shared Wi-Fi this would map your network)."""
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k in ("ssid", "bssid", "gateway", "mac", "hwaddr"):
                out[k] = "hidden"
            elif k == "endpoint":
                out[k] = None
            elif k == "listening":
                out[k] = []
            else:
                out[k] = _scrub(v)
        return out
    if isinstance(o, list):
        return [_scrub(v) for v in o]
    if isinstance(o, str):
        return _MAC_RE.sub("xx:xx:xx:xx:xx:xx", o)
    return o


def snapshot(trusted):
    with _lock:
        s = json.loads(json.dumps(_state, default=str))
    s.update(trusted=trusted, server_time=time.time(), vpn_ip=VPN_IP, vpn_subnet=str(VPN_NET), provider_name=PROVIDER_NAME,
             device_modes=device_modes(), failover=os.path.exists("/run/pgw/failover"), tor_via=tor_via(),
             price=PRICE_DEFAULTS)
    if not trusted:  # LAN viewers: no real IP, no device endpoints
        if s.get("exits", {}).get("isp"):
            s["exits"]["isp"] = {"redacted": True}
        for p in (s.get("wg1") or {}).get("peers", []):
            p["endpoint"] = None
        s = _scrub(s)
    return s


MANIFEST = json.dumps({"name": "Pi Privacy Gateway", "short_name": "Pi Privacy", "start_url": "/dashboard",
                       "display": "standalone", "background_color": "#0d0d0d", "theme_color": "#0d0d0d",
                       "icons": [{"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}]})
ICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0d0d0d"/>
<path d="M256 84 400 140v104c0 92-60 160-144 188-84-28-144-96-144-188V140z" fill="none" stroke="#3987e5" stroke-width="30" stroke-linejoin="round"/>
<circle cx="256" cy="250" r="52" fill="#0ca30c"/></svg>"""
STATIC = {"/dashboard": ("index.html", "text/html; charset=utf-8"),
          "/app.js": ("app.js", "application/javascript; charset=utf-8"),
          "/app.css": ("app.css", "text/css; charset=utf-8")}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def trusted(self):
        try:
            ip = ipaddress.ip_address(self.client_address[0])
            return ip in VPN_NET or ip.is_loopback
        except ValueError:
            return False

    def send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, default=str).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        for k, v in (("Content-Type", ctype), ("Cache-Control", "no-store"), ("Content-Length", str(len(body))),
                     ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
                     # connect-src: the leak test fetches Cloudflare's IPv4/IPv6 trace and a random
                     # *.example.com name (to see which resolver the device really uses)
                     ("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; "
                                                 "img-src 'self' data:; frame-ancestors 'none'; connect-src 'self' "
                                                 "https://1.1.1.1 https://ipv6.icanhazip.com https://*.example.com")):
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:  # noqa: BLE001
            pass

    def can_manage(self):
        return self.trusted() and (not ADMIN_IPS or self.client_address[0] in ADMIN_IPS)

    def guarded_post(self, manage=False):
        """VPN clients only; the custom header + JSON body force a CORS preflight we never answer."""
        if manage and self.trusted() and not self.can_manage():
            self.send(403, {"error": "only the admin devices in ADMIN_IPS can manage devices"})
            return None
        if not self.trusted():
            self.send(403, {"error": "connect through the VPN to do this"})
            return None
        if self.headers.get("X-Pi-Control") != "1" or "application/json" not in (self.headers.get("Content-Type") or ""):
            self.send(400, {"error": "bad request"})
            return None
        try:
            return json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 2048)) or b"{}")
        except ValueError:
            self.send(400, {"error": "bad json"})
            return None

    def stream(self):
        global _last_view
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        trusted = self.trusted()
        try:
            while True:
                _last_view = time.time()
                self.wfile.write(f"data: {json.dumps(snapshot(trusted), default=str)}\n\n".encode())
                self.wfile.flush()
                time.sleep(1)
        except Exception:  # noqa: BLE001 - client went away
            return

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        if path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/dashboard")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif path in STATIC:
            with open(os.path.join(WEB_DIR, STATIC[path][0]), "rb") as fh:
                self.send(200, fh.read(), STATIC[path][1])
        elif path == "/api/stream":
            self.stream()
        elif path == "/api/history":
            rng = (parse_qs(u.query).get("range") or [""])[0]
            if rng in RANGES:
                self.send(200, history_query(rng))
            else:
                with _lock:
                    self.send(200, {k: list(v) for k, v in _history.items()})
        elif path == "/api/devices":
            if not self.trusted():
                self.send(403, {"error": "connect through the VPN to see devices"})
            else:
                self.send(200, {"devices": devices(), "can_manage": self.can_manage(), "default": quick_mode(),
                                "provider": PROVIDER_NAME if os.path.exists(f"{WG_DIR}/wg2.conf") else None})
        elif path == "/api/leak/expect":
            if not self.trusted():
                self.send(403, {"error": "open the dashboard through the VPN to run the leak test"})
            else:
                self.send(200, {"client": self.client_address[0], **expected_exit(self.client_address[0])})
        elif path == "/api/status":
            self.send(200, snapshot(self.trusted()))
        elif path == "/api/tor/exit":
            if not self.trusted():
                self.send(403, {"error": "connect through the VPN to do this"})
                return
            self.send(200, {"country": tor_exit_country(), "options": TOR_COUNTRIES, "via": tor_via(), **bridge_state()})
        elif path == "/api/mode":  # cheap, for tray apps
            self.send(200, {"mode": quick_mode(), "kill_switch": (get("killswitch") or {}).get("armed", False),
                            "can_control": self.trusted(), "provider": PROVIDER_NAME if os.path.exists(f"{WG_DIR}/wg2.conf") else None})
        elif path == "/api/ids":
            if not self.trusted():
                self.send(403, {"error": "connect through the VPN to see connections"})
            else:
                self.send(200, ids_state())
        elif path == "/api/querylog":
            if not self.trusted():
                self.send(403, {"error": "the DNS log is only visible through the VPN"})
            else:
                self.send(200, querylog())
        elif path == "/api/trace":
            q = parse_qs(u.query)
            target, pth = (q.get("target") or ["1.1.1.1"])[0].strip(), (q.get("path") or ["warp"])[0]
            if not self.trusted():
                self.send(403, {"error": "traceroute is only available through the VPN"})
            elif pth not in ("warp", "isp") or not TARGET_RE.match(target):
                self.send(400, {"error": "invalid target"})
            else:
                self.send(200, traceroute(target, pth))
        elif path == "/manifest.webmanifest":
            self.send(200, MANIFEST, "application/manifest+json")
        elif path == "/icon.svg":
            self.send(200, ICON, "image/svg+xml")
        else:
            self.send(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/mode":
            body = self.guarded_post()
            if body is None:
                return
            mode = body.get("mode")
            if mode not in ("warp", "provider", "tor"):
                self.send(400, {"error": "mode must be warp, provider or tor"})
                return
            out = set_mode(mode)
            ok = f"exit mode: {mode}" in out
            self.send(200 if ok else 500, {"ok": ok, "mode": mode, "log": out})
        elif path in ("/api/devices/add", "/api/devices/remove", "/api/devices/exit", "/api/devices/qr"):
            body = self.guarded_post(manage=True)
            if body is None:
                return
            name = str(body.get("name") or "")
            if not NAME_RE.match(name):
                self.send(400, {"error": "name must be 1-32 letters, digits, - or _"})
                return
            if path.endswith("/add"):
                rc, out = pgw("add-peer", name, "--quiet")
                self.send(200 if rc == 0 else 400, {"ok": True, **peer_bundle(name)} if rc == 0 else {"error": out})
            elif path.endswith("/remove"):
                rc, out = pgw("remove-peer", name)
                self.send(200 if rc == 0 else 400, {"ok": rc == 0, "log": out})
            elif path.endswith("/exit"):
                mode = body.get("mode")
                if mode not in ("warp", "provider", "tor", "default"):
                    self.send(400, {"error": "mode must be warp, provider, tor or default"})
                    return
                with _mode_lock:
                    rc, out = pgw("device", name, mode)
                self.send(200 if rc == 0 else 400, {"ok": rc == 0, "log": out})
            else:
                b = peer_bundle(name)
                self.send(200 if b else 404, b or {"error": "no config stored for that device"})
        elif path == "/api/tor/restart":
            if self.guarded_post() is None:
                return
            ok, msg = tor_restart()
            self.send(200 if ok else 429 if msg == "wait" else 500, {"ok": ok, "error": None if ok else msg})
        elif path == "/api/tor/newcircuit":
            if self.guarded_post() is None:
                return
            try:
                ok = tor_control("SIGNAL NEWNYM")[0][0].startswith("250")
            except (OSError, IndexError):
                ok = False
            self.send(200 if ok else 500, {"ok": ok, "error": None if ok else "Tor is not reachable"})
        elif path == "/api/tor/bridge":
            body = self.guarded_post()
            if body is None:
                return
            if _bridge["busy"]:
                self.send(409, {"error": "a bridge change is already running"})
                return
            threading.Thread(target=bridge_switch, args=("snowflake" if body.get("on") else "off",), daemon=True).start()
            self.send(200, {"ok": True, "started": True})
        elif path == "/api/tor/via":
            body = self.guarded_post()
            if body is None:
                return
            via = body.get("via")
            if via not in ("warp", "provider"):
                self.send(400, {"error": "via must be warp or provider"})
                return
            with _mode_lock:
                r = subprocess.run(["/usr/local/bin/pgw-exit", "tor-via", via], capture_output=True, text=True, timeout=150)
            self.send(200 if r.returncode == 0 else 500, {"ok": r.returncode == 0, "via": tor_via(), "log": (r.stdout + r.stderr).strip()[-300:]})
        elif path == "/api/tor/exit":
            body = self.guarded_post()
            if body is None:
                return
            c = str(body.get("country") or "").lower()
            if c and c not in TOR_COUNTRIES:
                self.send(400, {"error": "unknown country"})
                return
            with open(EXIT_FILE, "w") as f:
                f.write(c)
            ok = tor_apply_exit()
            self.send(200 if ok else 500, {"ok": ok, "country": c, "error": None if ok else "Tor is not reachable (saved, will apply when it is)"})
        elif path == "/api/leak/dns":
            body = self.guarded_post()
            if body is None:
                return
            token = str(body.get("token") or "")
            if not re.fullmatch(r"[a-z0-9]{12,40}", token):
                self.send(400, {"error": "bad token"})
                return
            self.send(200, {"seen": dns_seen(token, self.client_address[0])})
        else:
            self.send(404, {"error": "not found"})


if __name__ == "__main__":
    medium()
    loop(1, fast)                  # /proc reads only: always on (keeps 5 min of history)
    loop(5, medium, 30)
    loop(5, components, 60)
    loop(10, latency, 600)
    loop(30, slow, 300)
    loop(60, tor_apply_exit)       # keeps the chosen exit country applied (also after Tor restarts)
    loop(60, history_sample)       # one row per minute, kept 30 days
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    srv.serve_forever()
