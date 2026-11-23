#!/usr/bin/env python3
"""agent-memory 本地向量服务（跑在宿主机或任意一台内网机器上，给中心做"按意思搜"）。

POST /embed {"texts": [...]} → {"model": ..., "vectors": [[...], ...]}（已归一化，点积 = 余弦相似度）
GET /health
模型：BAAI/bge-small-zh-v1.5（中文为主、也认英文，512 维，CPU 就够快），用 fastembed（onnxruntime）跑。
只监听 libvirt 网桥地址（虚拟机能访问，外面访问不到）。配置用环境变量：LISTEN（默认 192.168.122.1:8791）、
EMBED_MODEL、EMBED_THREADS（默认 8，别占满整台机器）、HF_ENDPOINT（国内用 https://hf-mirror.com）。
"""

import json
import os
import http.server
import socketserver
import threading

from fastembed import TextEmbedding

HOST, PORT = os.environ.get("LISTEN", "192.168.122.1:8791").rsplit(":", 1)
MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
THREADS = int(os.environ.get("EMBED_THREADS", "8"))
CACHE = os.environ.get("EMBED_CACHE", os.path.expanduser("~/am-embed/models"))

model = TextEmbedding(model_name=MODEL, cache_dir=CACHE, threads=THREADS)
lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": MODEL})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            texts = [str(t)[:2000] for t in body.get("texts", [])][:256]
            with lock:
                vecs = [v.tolist() for v in model.embed(texts, batch_size=32)]
            self._send(200, {"model": MODEL, "vectors": [[round(x, 6) for x in v] for v in vecs]})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e)})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    Server((HOST, int(PORT)), Handler).serve_forever()
