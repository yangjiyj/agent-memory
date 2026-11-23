#!/usr/bin/env python3
"""agent-memory 认证网关（跑在中心所在的宿主机上，监听 0.0.0.0:3190，转发到中心服务）。

作用：认出请求是哪台机器发的，告诉中心，中心据此自动登记设备，不用加入码、不用手动起名。
- 来自 Tailscale（100.64.0.0/10）：用 `tailscale whois` 认出机器名（MagicDNS 名，如 my-laptop）。
- 来自宿主机自己的虚拟机（默认 192.168.122.0/24，可用 VM_NETS 配）：按 libvirt 的租约认出虚拟机名。
- 其他来源（本机 127.0.0.1、ssh 隧道等）：不带身份，只能用已有令牌。
外部传来的 X-AM-* 头一律剥掉；加的身份头带一个只有网关和中心知道的暗号（X-AM-Gate）。
只用标准库。配置 /etc/am-gate.env：LISTEN_PORT、UPSTREAM、GATE_SECRET。
"""

import http.client
import http.server
import ipaddress
import json
import os
import socketserver
import subprocess
import threading
import time

LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "3190"))
UPSTREAM_HOST, UPSTREAM_PORT = os.environ.get("UPSTREAM", "192.168.122.50:8790").split(":")
SECRET = os.environ["GATE_SECRET"]
TAILNET = ipaddress.ip_network("100.64.0.0/10")
VM_NETS = [ipaddress.ip_network(n.strip()) for n in os.environ.get("VM_NETS", "192.168.122.0/24").split(",") if n.strip()]
VM_GATEWAYS = {g.strip() for g in os.environ.get("VM_GATEWAYS", "192.168.122.1").split(",") if g.strip()}
LIBVIRT_NETS = [n.strip() for n in os.environ.get("LIBVIRT_NETS", "default").split(",") if n.strip()]
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}

_cache = {}
_lock = threading.Lock()


def _cached(key, ttl, fn):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (now, val)
    return val


def _whois(ip):
    try:
        out = subprocess.run(["tailscale", "whois", "--json", ip], capture_output=True, text=True, timeout=5)
        d = json.loads(out.stdout)
        node = d.get("Node") or {}
        name = (node.get("Name") or "").split(".")[0] or node.get("ComputedName") or ""
        return {"name": name, "os": (node.get("Hostinfo") or {}).get("OS", ""), "kind": "tailnet"} if name else None
    except Exception:  # noqa: BLE001
        return None


def _vm_leases():
    m = {}
    for net in LIBVIRT_NETS:
        try:
            out = subprocess.run(["virsh", "-c", "qemu:///system", "net-dhcp-leases", net], capture_output=True, text=True, timeout=5).stdout
        except Exception:  # noqa: BLE001
            continue
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 6 and "/" in parts[4]:
                m[parts[4].split("/")[0]] = parts[5]
    return m


def _ts_peers():
    """Tailscale 节点：Tailscale IP → (机器名, 直连时的对端 IP)。装了 Tailscale 的虚拟机直连地址就是它的虚拟机内网 IP"""
    try:
        d = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=5).stdout)
    except Exception:  # noqa: BLE001
        return {}
    out = {}
    for p in (d.get("Peer") or {}).values():
        name = (p.get("DNSName") or "").split(".")[0]
        cur = (p.get("CurAddr") or "").rsplit(":", 1)[0].strip("[]")
        for tip in p.get("TailscaleIPs") or []:
            out[tip] = (name, cur)
    return out


def identify(ip):
    """返回 {name, kind, os, alt}；alt 是同一台机器的另一个身份（装了 Tailscale 的虚拟机：vm:名 ↔ tailnet:名）"""
    try:
        addr = ipaddress.ip_address(ip.removeprefix("::ffff:"))
    except ValueError:
        return None
    if addr in TAILNET:
        who = _cached(f"ts:{addr}", 600, lambda: _whois(str(addr)))
        if who:
            cur = _cached("tspeers", 120, _ts_peers).get(str(addr), ("", ""))[1]
            vm = _cached("leases", 120, _vm_leases).get(cur) if cur else None
            who = {**who, "alt": f"vm:{vm}" if vm and vm != "-" else ""}
        return who
    if any(addr in n for n in VM_NETS) and str(addr) not in VM_GATEWAYS:
        name = _cached("leases", 120, _vm_leases).get(str(addr))
        if not name or name == "-":
            return None
        ts = next((n for n, cur in _cached("tspeers", 120, _ts_peers).values() if cur == str(addr) and n), "")
        return {"name": name, "os": "", "kind": "vm", "alt": f"tailnet:{ts}" if ts else ""}
    return None


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # 响应头和正文是分两次写的：不关 Nagle 的话，第二次写要等浏览器的延迟 ACK，每个请求白白多 40ms
    disable_nagle_algorithm = True

    def log_message(self, fmt, *args):  # 只记错误，正常请求不刷屏
        pass

    def _proxy(self):
        peer = identify(self.client_address[0])
        length = int(self.headers.get("Content-Length") or 0)
        if length > 32 << 20:
            self.send_error(413)
            return
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and not k.lower().startswith("x-am-") and k.lower() != "host"}
        headers["Host"] = self.headers.get("Host", f"{UPSTREAM_HOST}:{UPSTREAM_PORT}")
        headers["X-AM-Gate"] = SECRET
        headers["X-AM-Peer-IP"] = self.client_address[0]
        if peer:
            headers["X-AM-Peer"] = peer["name"]
            headers["X-AM-Peer-Kind"] = peer["kind"]
            headers["X-AM-Peer-OS"] = peer["os"]
            if peer.get("alt"):
                headers["X-AM-Peer-Alt"] = peer["alt"]
        try:
            conn = http.client.HTTPConnection(UPSTREAM_HOST, int(UPSTREAM_PORT), timeout=300)
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
        except Exception as e:  # noqa: BLE001
            self.send_error(502, f"agent-memory hub unreachable: {e}")
            return
        self.send_response_only(resp.status, resp.reason)
        clen = resp.getheader("Content-Length")
        for k, v in resp.getheaders():
            if k.lower() not in HOP:
                self.send_header(k, v)
        if clen is None and self.command != "HEAD" and resp.status not in (204, 304):
            data = resp.read()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.end_headers()
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        conn.close()

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = _proxy


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    Server(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
