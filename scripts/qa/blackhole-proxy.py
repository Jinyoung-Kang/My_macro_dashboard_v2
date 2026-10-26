#!/usr/bin/env python3
"""
scripts/qa/blackhole-proxy.py — QA용 차단·지연 프록시.

수집기의 HTTP(S)_PROXY로 지정해 외부 요청을 **밖으로 내보내지 않고** 흉내 냅니다.
  block        즉시 502 (외부가 끊김)                      ← 기본
  hang         요청을 받고 응답하지 않음(최대 600초) (외부가 먹통)
  slow:N       N초 기다린 뒤 502 (외부가 느림)

모드는 실행 중 바꿉니다:  GET http://127.0.0.1:18890/__mode?set=hang
현재 모드·시도된 외부 호출 수:  GET http://127.0.0.1:18890/__mode
시도된 외부 호출은 표준출력에 한 줄씩 남습니다 — 어떤 호스트를 부르려 했는지의 증거입니다.
"""
from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

STATE = {"mode": "block", "attempts": 0, "hosts": {}}
LOCK = threading.Lock()
HANG_SECONDS = 600


def _record(method: str, host: str) -> None:
    with LOCK:
        STATE["attempts"] += 1
        STATE["hosts"][host] = STATE["hosts"].get(host, 0) + 1
    print(f"{time.strftime('%H:%M:%S')} {STATE['mode']:<8} {method:<7} {host}", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):   # 기본 접근 로그는 끕니다(위 _record가 남김)
        return

    def _control(self) -> bool:
        parts = urlsplit(self.path)
        if parts.path != "/__mode":
            return False
        wanted = parse_qs(parts.query).get("set", [None])[0]
        if wanted:
            if wanted in ("block", "hang") or (wanted.startswith("slow:") and wanted[5:].isdigit()):
                with LOCK:
                    STATE["mode"] = wanted
            else:
                self._json(400, {"error": "mode는 block | hang | slow:N"})
                return True
        with LOCK:
            body = dict(STATE)
        self._json(200, body)
        return True

    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _blackhole(self, method: str, host: str) -> None:
        _record(method, host)
        mode = STATE["mode"]
        if mode == "hang":
            time.sleep(HANG_SECONDS)
            return   # 연결을 그냥 닫습니다
        if mode.startswith("slow:"):
            time.sleep(int(mode[5:]))
        self.send_response(502, "QA blackhole")
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def do_CONNECT(self):
        self._blackhole("CONNECT", self.path.split(":")[0])

    def _plain(self):
        if self._control():
            return
        host = urlsplit(self.path).hostname or self.headers.get("Host", "?")
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self._blackhole(self.command, host)

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_OPTIONS = do_PATCH = _plain


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default="127.0.0.1:18890")
    args = parser.parse_args()
    host, port = args.listen.rsplit(":", 1)
    server = ThreadingHTTPServer((host, int(port)), Handler)
    server.daemon_threads = True
    print(f"blackhole proxy on {args.listen} mode={STATE['mode']}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    socket.setdefaulttimeout(None)
    main()
