"""포트폴리오 데모 잠금화면(gate).

Caddy 의 forward_auth 뒤에서 동작한다. 접근 코드를 맞히면 서비스별 서명 쿠키를 주고,
쿠키가 없거나 틀린 요청은 앱에 닿기 전에 막는다(화면 이동은 잠금화면, 나머지는 401 JSON).

끝점
  GET  /__gate/verify   Caddy forward_auth 용 — 200 이면 통과
  GET  /__gate/         잠금화면
  POST /__gate/unlock   접근 코드 확인 → 쿠키 발급 → next 로 이동
  GET  /__gate/lock     쿠키 지우기
  GET  /__gate/healthz  상태 확인

Caddy 가 붙여 주는 헤더만 믿는다: X-Gate-Service(서비스 키), X-Gate-Client-IP(실제 클라이언트 IP).
그래서 이 서버는 127.0.0.1 에만 열어야 한다.

설정(환경변수)
  GATE_SECRET          쿠키 서명 키 (32자 이상)
  GATE_CODES           "이름:해시,이름:해시" — 해시는 `python gate.py hash` 로 만든다(코드는 stdin)
  GATE_SERVICES_FILE   서비스별 제목·안내 JSON (기본: 같은 폴더의 services.json)
  GATE_HOURS           잠금화면에 적을 운영 시간
  GATE_COOKIE_TTL      쿠키 수명(초, 기본 43200 = 12시간)
  GATE_COOKIE_SECURE   "false" 면 Secure 를 빼고 __Host- 접두사도 쓰지 않음(로컬 시험용)
  GATE_LISTEN          "host:port" (기본 127.0.0.1:8100)
  TELEGRAM_BOT_TOKEN   텔레그램 알림(선택) — 잠금 해제 · 차단을 운영자에게. 둘 다 있어야 켜진다
  TELEGRAM_CHAT_ID     알림을 받을 chat id
"""

from __future__ import annotations

import base64
import collections
import hashlib
import hmac
import html
import ipaddress
import json
import math
import os
import queue
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, NamedTuple
from urllib.parse import parse_qs, urlsplit

PREFIX = "/__gate"
MAX_FORM_BYTES = 2048
MAX_CODE_CHARS = 200
MAX_NEXT_CHARS = 2000

# 해시 형식 scrypt.N.r.p.salt.hash — `$` 를 쓰지 않는다(compose .env 치환과 부딪힘).
# scrypt: n=2^14, r=8, p=1 — 한 번에 약 16 MiB · 수십 ms. 코드가 여러 개면 그만큼 느려져 무차별 대입도 느려진다.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1

# 무차별 대입 제한
IP_WINDOW_S, IP_MAX_FAILS, IP_LOCK_S = 15 * 60, 5, 15 * 60
GLOBAL_WINDOW_S, GLOBAL_MAX_FAILS, GLOBAL_LOCK_S = 60 * 60, 30, 30 * 60
MAX_TRACKED_IPS = 10_000
# 결과를 기다리는 시도까지 세어 한도에 닿았을 때 돌려줄 대기(초) — 그 시도들이 실패하면 곧 잠긴다
IN_FLIGHT_RETRY_S = 5

# 코드 검사(scrypt)를 동시에 돌리는 수의 상한. 한 번에 약 16 MiB(128·r·N)라 상한 없이 겹치면 컨테이너 상한(compose mem_limit 96m)을
# 넘어 OOM 으로 죽고, 그 사이 세 서비스 모두 잠금화면이 사라지며 시도 기록도 초기화된다(QA-1602). 넘치면 기다리게 하지 않고 바로 429.
# 실측(96m 컨테이너의 memory.peak): 동시 2개 49 MiB · 4개 82 MiB · 5개부터 OOM. 코드 확인은 한 사람이 12시간에 한 번이라 2개면 충분하다.
MAX_CONCURRENT_CHECKS = 2
BUSY_RETRY_S = 1

# 텔레그램 알림 — 요청 스레드는 큐에 넣기만 하고 작업자 스레드 하나가 보낸다(재시도 없음).
NOTIFY_QUEUE_MAX = 50       # 보낼 알림 대기열 — 넘치면 버리고 로그
NOTIFY_REPEAT_S = 60 * 60   # 같은 (서비스, IP) 의 잠금 해제는 이 안에 다시 알리지 않는다
NOTIFY_SEEN_MAX = 1000      # 그 판단에 기억하는 (서비스, IP) 수 — 넘치면 지난 것 · 오래된 것부터 지운다
# 잠금 해제 알림은 모든 서비스 · IP 를 합쳐 이 시간에 이만큼까지 — 코드를 가진 사람이 IP 를 바꿔 가며 해제해도 알림이 쌓이지 않게.
# 넘친 해제는 보내지 않고 세어 두었다가 다음 해제 알림에 'k건' 으로 덧붙인다(전체 기록은 unlock_ok 로그).
NOTIFY_UNLOCK_WINDOW_S, NOTIFY_UNLOCK_MAX = 10 * 60, 10
TELEGRAM_API = "https://api.telegram.org"
TELEGRAM_TIMEOUT_S = 5
UA_MAX_CHARS = 512          # 기기 요약에 보는 User-Agent 앞부분(정규식이 긴 헤더에 오래 걸리지 않게)
# 한국은 서머타임이 없다. slim 이미지에 tzdata 가 없을 수 있어 zoneinfo 대신 고정 오프셋
KST = timezone(timedelta(hours=9), "KST")
UNKNOWN = "알 수 없음"


# ── 접근 코드 해시 ─────────────────────────────────────────────


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_code(code: str, *, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(code.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt.{SCRYPT_N}.{SCRYPT_R}.{SCRYPT_P}.{_b64e(salt)}.{_b64e(digest)}"


def check_code(code: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt, want = encoded.split(".")
        if scheme != "scrypt":
            return False
        got = hashlib.scrypt(code.encode("utf-8"), salt=_b64d(salt), n=int(n), r=int(r), p=int(p), dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, _b64d(want))


def parse_codes(raw: str) -> dict[str, str]:
    """"이름:해시,이름:해시" → {이름: 해시}. 이름은 영숫자·-·_ 만."""
    codes: dict[str, str] = {}
    for item in filter(None, (part.strip() for part in raw.split(","))):
        name, sep, encoded = item.partition(":")
        if not sep or not name or not all(c.isalnum() or c in "-_" for c in name):
            raise ValueError(f"GATE_CODES 항목 형식이 틀림: {name or '(빈 이름)'}")
        if not encoded.startswith("scrypt."):
            raise ValueError(f"GATE_CODES[{name}] 는 scrypt 해시여야 함")
        codes[name] = encoded
    return codes


# ── 서명 쿠키 ─────────────────────────────────────────────────


def sign_token(secret: bytes, service: str, code_name: str, expires_at: int) -> str:
    body = _b64e(json.dumps({"s": service, "n": code_name, "e": expires_at}, separators=(",", ":")).encode())
    mac = _b64e(hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{mac}"


def read_token(secret: bytes, token: str, *, service: str, now: float) -> str | None:
    """올바르면 코드 이름, 아니면 None."""
    body, sep, mac = token.partition(".")
    if not sep:
        return None
    want = _b64e(hmac.new(secret, body.encode("utf-8", "replace"), hashlib.sha256).digest())
    # 바이트로 비교 — 쿠키에 비 ASCII 문자가 섞여 와도 예외 없이 거절한다.
    if not hmac.compare_digest(want.encode("ascii"), mac.encode("utf-8", "replace")):
        return None
    try:
        data = json.loads(_b64d(body))
        if data["s"] != service or int(data["e"]) <= now:
            return None
        return str(data["n"])
    except (ValueError, KeyError, TypeError):
        return None


# ── 시도 제한 ─────────────────────────────────────────────────



def retry_text(wait: float) -> str:
    """429 안내의 '언제 다시' — 1분 미만은 초로(결과를 기다리는 시도 때문의 짧은 대기), 그 이상은 분으로(잠김)."""
    if wait < 60:
        return f"약 {max(1, math.ceil(wait))}초 뒤에"
    return f"약 {round(wait / 60)}분 뒤에"


class NewLocks(NamedTuple):
    """이번 실패로 새로 걸린 잠금(알림용). 이미 잠긴 동안의 거절은 begin_attempt 에서 끝나 여기까지 오지 않는다."""

    ip_locked: bool = False
    global_locked: bool = False


@dataclass
class Limiter:
    """IP · 전체 실패 수로 잠근다.

    잠금 해제 요청은 begin_attempt → (코드 검사) → finish_attempt 순서로 쓴다. 확인과 '시도 몫 잡기'를 한 잠금 안에서 하고,
    결과를 기다리는 시도도 한도에 센다 — 동시에 들어온 요청이 모두 확인을 통과한 뒤 각자 코드를 검사하던 경쟁(QA-1601)을 막는다.
    """

    fails_by_ip: dict[str, collections.deque] = field(default_factory=dict)
    locked_ip_until: dict[str, float] = field(default_factory=dict)
    global_fails: collections.deque = field(default_factory=collections.deque)
    global_locked_until: float = 0.0
    pending_by_ip: dict[str, int] = field(default_factory=dict)  # 몫을 잡고 결과를 아직 모르는 시도
    pending_total: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def blocked_for(self, ip: str, now: float) -> float:
        """잠겨 있으면 남은 초, 아니면 0."""
        with self.lock:
            return self._locked_for(ip, now)

    def begin_attempt(self, ip: str, now: float) -> float:
        """코드를 검사하기 전에 시도 몫을 잡는다. 0 이면 잡은 것 — 반드시 finish_attempt 나 cancel_attempt 로 끝낸다.

        잠겨 있으면 남은 초를, 결과를 기다리는 시도까지 세어 한도에 닿았으면 IN_FLIGHT_RETRY_S 를 돌려주고 몫을 잡지 않는다.
        """
        with self.lock:
            wait = self._locked_for(ip, now)
            if wait > 0:
                return wait
            ip_fails = self._recent(self.fails_by_ip.get(ip), now, IP_WINDOW_S)
            global_fails = self._recent(self.global_fails, now, GLOBAL_WINDOW_S)
            pending = self.pending_by_ip.get(ip, 0)
            if ip_fails + pending >= IP_MAX_FAILS or global_fails + self.pending_total >= GLOBAL_MAX_FAILS:
                return float(IN_FLIGHT_RETRY_S)
            self.pending_by_ip[ip] = pending + 1
            self.pending_total += 1
            return 0.0

    def finish_attempt(self, ip: str, now: float, ok: bool) -> NewLocks:
        """잡은 몫을 결과로 바꾼다 — 맞으면 몫을 돌려주고 그 IP 의 실패를 지우며, 틀리면 실패로 기록한다.

        이번 실패로 IP · 전체 잠금이 새로 걸렸는지 돌려준다(알림용 — 잠금 동작은 그대로).
        """
        with self.lock:
            self._release(ip)
            if ok:
                self.fails_by_ip.pop(ip, None)
                return NewLocks()
            return self._record_failure(ip, now)

    def cancel_attempt(self, ip: str) -> None:
        """코드를 검사하지 못했을 때(동시 검사 상한) — 몫만 돌려주고 실패로 세지 않는다."""
        with self.lock:
            self._release(ip)

    def record_failure(self, ip: str, now: float) -> NewLocks:
        with self.lock:
            return self._record_failure(ip, now)

    def record_success(self, ip: str) -> None:
        with self.lock:
            self.fails_by_ip.pop(ip, None)

    # ── 아래는 self.lock 을 쥔 채로만 부른다 ──
    def _locked_for(self, ip: str, now: float) -> float:
        return max(self.global_locked_until - now, self.locked_ip_until.get(ip, 0.0) - now, 0.0)

    @staticmethod
    def _recent(fails: collections.deque | None, now: float, window: float) -> int:
        if not fails:
            return 0
        while fails and fails[0] <= now - window:
            fails.popleft()
        return len(fails)

    def _release(self, ip: str) -> None:
        left = self.pending_by_ip.get(ip, 0) - 1
        if left > 0:
            self.pending_by_ip[ip] = left
        else:
            self.pending_by_ip.pop(ip, None)
        self.pending_total = max(self.pending_total - 1, 0)

    def _record_failure(self, ip: str, now: float) -> NewLocks:
        if len(self.fails_by_ip) >= MAX_TRACKED_IPS and ip not in self.fails_by_ip:
            self._prune(now)
        fails = self.fails_by_ip.setdefault(ip, collections.deque())
        fails.append(now)
        while fails and fails[0] <= now - IP_WINDOW_S:
            fails.popleft()
        ip_locked = global_locked = False
        if len(fails) >= IP_MAX_FAILS:
            self.locked_ip_until[ip] = now + IP_LOCK_S
            fails.clear()
            ip_locked = True
        self.global_fails.append(now)
        while self.global_fails and self.global_fails[0] <= now - GLOBAL_WINDOW_S:
            self.global_fails.popleft()
        if len(self.global_fails) >= GLOBAL_MAX_FAILS:
            self.global_locked_until = now + GLOBAL_LOCK_S
            self.global_fails.clear()
            global_locked = True
        return NewLocks(ip_locked, global_locked)

    def _prune(self, now: float) -> None:
        for ip in [ip for ip, until in self.locked_ip_until.items() if until <= now]:
            del self.locked_ip_until[ip]
        for ip in [ip for ip, q in self.fails_by_ip.items() if not q or q[-1] <= now - IP_WINDOW_S]:
            del self.fails_by_ip[ip]
        while len(self.fails_by_ip) >= MAX_TRACKED_IPS:  # 그래도 넘치면 오래된 것부터
            del self.fails_by_ip[next(iter(self.fails_by_ip))]


# ── 설정 ──────────────────────────────────────────────────────


@dataclass
class Config:
    # 서명 키 · 코드 해시도 repr 에 찍히지 않게 — 설정 객체가 로그 · 예외 메시지에 실려도 비밀값은 남지 않는다
    secret: bytes = field(repr=False)
    codes: dict[str, str] = field(repr=False)
    services: dict[str, dict]
    hours: str
    cookie_ttl: int
    cookie_secure: bool
    # 텔레그램 알림 — repr 에 찍히지 않게(토큰은 요청 URL 에 들어간다)
    telegram_token: str = field(default="", repr=False)
    telegram_chat_id: str = field(default="", repr=False)

    @property
    def cookie_name(self) -> str:
        return "__Host-pf_gate" if self.cookie_secure else "pf_gate"

    @property
    def telegram_on(self) -> bool:
        return bool(self.telegram_token and self.telegram_chat_id)

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        env = dict(os.environ if env is None else env)
        secret = env.get("GATE_SECRET", "")
        if len(secret) < 32:
            raise ValueError("GATE_SECRET 은 32자 이상이어야 함")
        codes = parse_codes(env.get("GATE_CODES", ""))
        if not codes:
            raise ValueError("GATE_CODES 가 비어 있음")
        services_file = Path(env.get("GATE_SERVICES_FILE") or Path(__file__).with_name("services.json"))
        services = json.loads(services_file.read_text(encoding="utf-8"))
        token = env.get("TELEGRAM_BOT_TOKEN", "").strip()
        chat_id = env.get("TELEGRAM_CHAT_ID", "").strip()
        if bool(token) != bool(chat_id):  # 하나만 있으면 끈다 — 값은 찍지 않고 빈 쪽 이름만
            log_event("telegram_off", missing="TELEGRAM_CHAT_ID" if token else "TELEGRAM_BOT_TOKEN")
            token = chat_id = ""
        return cls(
            secret=secret.encode("utf-8"),
            codes=codes,
            services=services,
            hours=env.get("GATE_HOURS", "평일 09:00–18:00 (KST)"),
            cookie_ttl=int(env.get("GATE_COOKIE_TTL", "43200")),
            cookie_secure=env.get("GATE_COOKIE_SECURE", "true").lower() != "false",
            telegram_token=token,
            telegram_chat_id=chat_id,
        )


# ── 화면 ──────────────────────────────────────────────────────

PAGE_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
    "frame-ancestors 'none'; base-uri 'none'"
)

PAGE = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>{title} · 잠금</title>
<style>
  :root {{ --bg:#f4f5f7; --card:#fff; --text:#16181d; --muted:#5d6470; --line:#d9dce1;
          --accent:#2b59c3; --accent-text:#fff; --error:#b42318; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#111317; --card:#1a1d23; --text:#e8eaee; --muted:#9aa1ad; --line:#2d323b;
            --accent:#6b93ef; --accent-text:#0d1017; --error:#f97066; }}
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px;
         background:var(--bg); color:var(--text);
         font:15px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
         word-break:keep-all; overflow-wrap:break-word; }}
  main {{ width:100%; max-width:400px; background:var(--card); border:1px solid var(--line);
         border-radius:14px; padding:28px 24px; }}
  /* 문장마다 새 줄, 줄 안에서는 낱말 사이에서만 줄바꿈 — '·' 로 나뉜 항목은 통째로 */
  .ln {{ display:block; text-wrap:pretty; }}
  .u {{ white-space:nowrap; }}
  .lock {{ font-size:13px; color:var(--muted); letter-spacing:.04em; margin:0 0 6px; }}
  h1 {{ font-size:21px; margin:0 0 4px; text-wrap:balance; }}
  .desc {{ color:var(--muted); margin:0 0 20px; }}
  label {{ display:block; font-weight:600; margin-bottom:6px; }}
  input {{ width:100%; padding:11px 12px; font-size:16px; border:1px solid var(--line); border-radius:8px;
          background:var(--bg); color:var(--text); }}
  input:focus {{ outline:2px solid var(--accent); outline-offset:1px; }}
  button {{ width:100%; margin-top:12px; padding:11px; font-size:15px; font-weight:600; border:0;
           border-radius:8px; background:var(--accent); color:var(--accent-text); cursor:pointer; }}
  .error {{ color:var(--error); margin:10px 0 0; }}
  .meta {{ margin:20px 0 0; padding-top:16px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }}
  .meta p {{ margin:4px 0; }}
</style>
</head>
<body>
<main>
  <p class="lock">🔒 접근 코드가 필요합니다</p>
  <h1>{title}</h1>
  <p class="desc">{description}</p>
  <form method="post" action="{prefix}/unlock">
    <input type="hidden" name="next" value="{next}">
    <label for="code">접근 코드</label>
    <input id="code" name="code" type="password" autocomplete="off" autocapitalize="off"
           spellcheck="false" maxlength="{max_code}" required autofocus>
    <button type="submit">잠금 해제</button>
    {error}
  </form>
  <div class="meta">
    <p>{intro}</p>
    <p>운영 시간: <span class="u">{hours}</span></p>
    {note}
  </div>
</main>
</body>
</html>
"""


INTRO = "포트폴리오 데모입니다. 접근 코드는 포트폴리오 문서에 있습니다."
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
ITEM_SEP = " · "


def text_lines(value: str | list[str]) -> str:
    """안내 문구를 HTML 로 — 문장(또는 목록의 항목)마다 새 줄, '·' 로 나뉜 항목은 중간에서 끊지 않는다."""
    lines = value if isinstance(value, list) else SENTENCE_END.split(value.strip())
    out = []
    for line in (ln.strip() for ln in lines):
        if not line:
            continue
        items = line.split(ITEM_SEP)
        if len(items) > 1:  # 구분점은 앞 항목에 붙여, 줄이 '·' 로 시작하지 않게
            last = len(items) - 1
            inner = " ".join(
                f'<span class="u">{html.escape(item)}{"" if i == last else chr(0xA0) + "·"}</span>'
                for i, item in enumerate(items))
        else:
            inner = html.escape(line)
        out.append(f'<span class="ln">{inner}</span>')
    return "".join(out)


def render_page(cfg: Config, service: str, next_path: str, error: str = "") -> bytes:
    meta = cfg.services.get(service, {})
    note = meta.get("note", "")
    return PAGE.format(
        title=html.escape(meta.get("title", "포트폴리오 데모")),
        description=text_lines(meta.get("description", "")),
        prefix=PREFIX,
        next=html.escape(next_path, quote=True),
        max_code=MAX_CODE_CHARS,
        error=f'<p class="error" role="alert">{text_lines(error)}</p>' if error else "",
        intro=text_lines(INTRO),
        hours=html.escape(cfg.hours),
        note=f"<p>{text_lines(note)}</p>" if note else "",
    ).encode("utf-8")


def safe_next(raw: str | None) -> str:
    """같은 사이트 안의 경로만 허용 — 열린 리디렉션 방지."""
    if not raw or len(raw) > MAX_NEXT_CHARS:
        return "/"
    if not raw.startswith("/") or raw.startswith("//") or raw.startswith("/\\"):
        return "/"
    if any(ch in raw for ch in "\r\n\t\\") or raw.startswith(PREFIX):
        return "/"
    return raw


# ── 텔레그램 알림 ─────────────────────────────────────────────

# 순서가 중요하다 — Edge · Whale · 삼성 · 카카오 UA 에도 Chrome · Safari 가, iPhone · iPad UA 에도 Mac OS X 가, Android UA 에도 Linux 가 들어 있다.
UA_BROWSERS = (
    (re.compile(r"KAKAOTALK"), "카카오톡"),
    (re.compile(r"NAVER\(inapp"), "네이버 앱"),
    (re.compile(r"Whale/"), "Whale"),
    (re.compile(r"SamsungBrowser/"), "Samsung Internet"),
    (re.compile(r"Edg(?:A|iOS)?/"), "Edge"),
    (re.compile(r"OPR/|Opera"), "Opera"),
    (re.compile(r"Firefox/|FxiOS/"), "Firefox"),
    (re.compile(r"Chrome/|CriOS/"), "Chrome"),
    (re.compile(r"Version/[\d.]+.*Safari/"), "Safari"),
)
UA_SYSTEMS = (
    (re.compile(r"iPhone"), "iOS"),
    (re.compile(r"iPad"), "iPadOS"),
    (re.compile(r"Android"), "Android"),
    (re.compile(r"Windows"), "Windows"),
    (re.compile(r"Mac OS X|Macintosh"), "macOS"),
    (re.compile(r"CrOS"), "ChromeOS"),
    (re.compile(r"Linux"), "Linux"),
)


def describe_device(user_agent: str | None) -> str:
    """User-Agent 를 '브라우저 · OS' 로 줄인다 — 원문은 알림에 보내지 않는다. 모르는 쪽은 '알 수 없음', 둘 다 모르면 '알 수 없음'."""
    ua = (user_agent or "")[:UA_MAX_CHARS]
    browser = next((name for pattern, name in UA_BROWSERS if pattern.search(ua)), None)
    system = next((name for pattern, name in UA_SYSTEMS if pattern.search(ua)), None)
    if browser is None and system is None:
        return UNKNOWN
    return f"{browser or UNKNOWN} · {system or UNKNOWN}"


def mask_ip(raw: str | None) -> str:
    """알림에 적을 IP — IPv4 는 앞 세 자리(211.234.12.x), IPv6 는 /48 네트워크.

    IPv4-mapped(::ffff:1.2.3.4) 와 6to4(2002::/16 — /48 안에 IPv4 32비트가 통째로 든다)는 그 IPv4 로 본다.
    ipaddress 는 문자열을 직접 해석한다(DNS 조회 없음). 해석하지 못하면 '알 수 없음'.
    """
    try:
        addr = ipaddress.ip_address((raw or "").strip())
    except ValueError:
        return UNKNOWN
    if addr.version == 6:
        addr = addr.ipv4_mapped or addr.sixtofour or addr
    if addr.version == 4:
        return str(addr).rsplit(".", 1)[0] + ".x"
    return str(ipaddress.IPv6Network((int(addr), 48), strict=False))


def kst_text(ts: float) -> str:
    return datetime.fromtimestamp(ts, KST).strftime("%Y-%m-%d %H:%M %Z")


def duration_text(seconds: int) -> str:
    """알림 문구용 — 3600 → '1시간', 900 → '15분'."""
    return f"{seconds // 3600}시간" if seconds % 3600 == 0 else f"{seconds // 60}분"


class TelegramTransport:
    """sendMessage 로 한 건 보낸다. 실패는 예외로 끝난다.

    토큰이 요청 URL 에 들어가므로 URL · 예외 문구는 어디에도 남기지 않는다(repr 도 가린다).
    """

    def __init__(self, token: str, chat_id: str, timeout: float = TELEGRAM_TIMEOUT_S):
        self._url = f"{TELEGRAM_API}/bot{token}/sendMessage"
        self._chat_id = chat_id
        self._timeout = timeout

    def __repr__(self) -> str:
        return "TelegramTransport(<가림>)"

    def __call__(self, text: str) -> None:
        # 평문(parse_mode 없음). 링크 미리보기 끄기는 Bot API 7.0 부터 link_preview_options(disable_web_page_preview 를 대신함)
        body = {"chat_id": self._chat_id, "text": text, "link_preview_options": {"is_disabled": True}}
        request = urllib.request.Request(self._url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                         headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
        with urllib.request.urlopen(request, timeout=self._timeout) as res:
            res.read()


class Notifier:
    """잠금 해제 · 차단을 운영자 텔레그램으로 알린다 — 외부 사람이 접근 코드로 들어오면 바로 알려고.

    요청 스레드는 메시지를 만들어 큐에 넣기만 하고(차 있으면 버림) 작업자 스레드 하나가 transport 로 보낸다. 재시도는 없다(429 포함).
    어떤 실패도 밖으로 예외를 내지 않는다 — 잠금 해제 · 차단 응답에 영향이 없어야 한다. transport 가 None 이면 꺼진 것.
    """

    def __init__(self, services: dict[str, dict], transport: Callable[[str], None] | None = None, *,
                 clock: Callable[[], float] = time.time, queue_size: int = NOTIFY_QUEUE_MAX):
        self.services = services
        self.transport = transport
        self.clock = clock
        self._queue: queue.Queue = queue.Queue(maxsize=queue_size)  # (종류, 메시지)
        self._seen: dict[tuple[str, str], float] = {}  # (서비스, 전체 IP) → 잠금 해제를 알린 시각. 넣은 순서 = 오래된 순서
        self._seen_lock = threading.Lock()  # _seen · _recent · _unsaid 를 지킨다
        self._recent: collections.deque[float] = collections.deque()  # NOTIFY_UNLOCK_WINDOW_S 안에 큐에 넣은 해제 알림 시각
        self._unsaid = 0  # 아직 알리지 못한 해제 수(상한 · 큐가 차서) — 다음 해제 알림에 덧붙인다
        self._idle = threading.Condition()  # 큐에 넣고 아직 끝나지 않은 수(_unsent)를 지킨다
        self._unsent = 0
        if transport is not None:
            threading.Thread(target=self._work, name="telegram", daemon=True).start()

    @classmethod
    def from_config(cls, cfg: Config) -> "Notifier":
        transport = TelegramTransport(cfg.telegram_token, cfg.telegram_chat_id) if cfg.telegram_on else None
        return cls(cfg.services, transport)

    @property
    def enabled(self) -> bool:
        return self.transport is not None

    # ── 알림 세 가지 — 요청 스레드에서 부른다 ──
    def unlocked(self, service: str, ip: str, code_name: str, user_agent: str | None) -> None:
        """잠금 해제 성공. 같은 (서비스, 전체 IP) 는 NOTIFY_REPEAT_S 안에 다시 알리지 않는다.

        전체로는 NOTIFY_UNLOCK_WINDOW_S 에 NOTIFY_UNLOCK_MAX 건까지 — 넘친 것은 세어 두었다가 다음 알림에 덧붙인다.
        """
        if not self.enabled:
            return
        try:
            now = self.clock()
            with self._seen_lock:
                last = self._seen.get((service, ip))
                if last is not None and now - last < NOTIFY_REPEAT_S:
                    return
                while self._recent and now - self._recent[0] >= NOTIFY_UNLOCK_WINDOW_S:
                    self._recent.popleft()
                if len(self._recent) >= NOTIFY_UNLOCK_MAX:  # 기억하지 않는다 — 상한이 풀린 뒤 같은 IP 가 다시 풀면 알린다
                    self._unsaid += 1
                    log_event("telegram_capped", kind="unlock")
                    return
                lines = [f"🔓 {self._title(service)} — 잠금 해제", f"코드: {code_name}",
                         *self._when_where(now, ip, user_agent)]
                if self._unsaid:
                    lines.append(f"그 사이 알리지 못한 잠금 해제 {self._unsaid}건 "
                                 f"({duration_text(NOTIFY_UNLOCK_WINDOW_S)}에 {NOTIFY_UNLOCK_MAX}건까지만 알립니다)")
                if self._put("unlock", "\n".join(lines)):
                    self._remember((service, ip), now)
                    self._recent.append(now)
                    self._unsaid = 0
                else:  # 버렸으면 기억하지 않는다 — 다음 해제 때 다시 알리고, 이 건도 그때 수에 넣는다
                    self._unsaid += 1
        except Exception as e:  # 알림 때문에 잠금 해제가 실패하면 안 된다
            log_event("telegram_error", kind="unlock", error=type(e).__name__)

    def locked_ip(self, service: str, ip: str, user_agent: str | None) -> None:
        """IP 하나가 잠긴 순간 — 그 시도에서 한 번(잠긴 동안의 거절로는 부르지 않는다)."""
        if not self.enabled:
            return
        try:
            now = self.clock()
            self._put("locked_ip", "\n".join([
                f"⛔ {self._title(service)} — 접근 코드 {IP_MAX_FAILS}회 실패",
                f"{duration_text(IP_WINDOW_S)} 안에 {IP_MAX_FAILS}회 틀려 이 IP 를 {duration_text(IP_LOCK_S)} 동안 막습니다",
                *self._when_where(now, ip, user_agent)]))
        except Exception as e:
            log_event("telegram_error", kind="locked_ip", error=type(e).__name__)

    def locked_global(self, service: str) -> None:
        """전체 잠금이 걸린 순간 — 그 시도에서 한 번. service 는 마지막 실패가 들어온 서비스."""
        if not self.enabled:
            return
        try:
            now = self.clock()
            self._put("locked_global", "\n".join([
                f"🚨 {self._title(service)} — 전체 잠금",
                f"{duration_text(GLOBAL_WINDOW_S)} 안에 {GLOBAL_MAX_FAILS}회 틀려 "
                f"{duration_text(GLOBAL_LOCK_S)} 동안 모든 서비스의 시도를 막습니다",
                f"시각: {kst_text(now)}"]))
        except Exception as e:
            log_event("telegram_error", kind="locked_global", error=type(e).__name__)

    def flush(self, timeout: float) -> bool:
        """넣은 알림을 모두 보내(거나 실패할) 때까지 기다린다 — 시험용. 시간 안에 끝나면 True."""
        with self._idle:
            return self._idle.wait_for(lambda: self._unsent == 0, timeout)

    # ── 내부 ──
    def _title(self, service: str) -> str:
        return (self.services.get(service) or {}).get("title") or service

    @staticmethod
    def _when_where(now: float, ip: str, user_agent: str | None) -> list[str]:
        # 메시지에는 가린 IP 와 요약한 기기만 — 전체 IP · UA 원문은 보내지 않는다
        return [f"시각: {kst_text(now)}", f"IP: {mask_ip(ip)}", f"기기: {describe_device(user_agent)}"]

    def _put(self, kind: str, text: str) -> bool:
        with self._idle:
            try:
                self._queue.put_nowait((kind, text))
            except queue.Full:  # 작업자가 밀려 있다(텔레그램이 느리거나 막힘) — 기다리지 않고 버린다
                log_event("telegram_dropped", kind=kind)
                return False
            self._unsent += 1
            return True

    def _remember(self, key: tuple[str, str], now: float) -> None:
        """self._seen_lock 을 쥔 채로 부른다."""
        self._seen.pop(key, None)  # 다시 넣어 맨 뒤로
        if len(self._seen) >= NOTIFY_SEEN_MAX:
            for old in [k for k, at in self._seen.items() if now - at >= NOTIFY_REPEAT_S]:
                del self._seen[old]
            while len(self._seen) >= NOTIFY_SEEN_MAX:  # 그래도 넘치면 오래된 것부터
                del self._seen[next(iter(self._seen))]
        self._seen[key] = now

    def _work(self) -> None:
        while True:
            kind, text = self._queue.get()
            try:
                self.transport(text)
            except urllib.error.HTTPError as e:  # 429 도 다시 보내지 않는다
                log_event("telegram_failed", kind=kind, status=e.code)
            except Exception as e:  # 문구에 토큰이 든 URL 이 섞일 수 있어 예외 이름만
                log_event("telegram_failed", kind=kind, error=type(e).__name__)
            finally:
                with self._idle:
                    self._unsent -= 1
                    self._idle.notify_all()


# ── HTTP ──────────────────────────────────────────────────────


def log_event(event: str, **fields) -> None:
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event, **fields}
    print(json.dumps(record, ensure_ascii=False), flush=True)


class GateHandler(BaseHTTPRequestHandler):
    server_version = "gate"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    cfg: Config
    limiter: Limiter
    checks: threading.BoundedSemaphore  # 동시 코드 검사 자리(MAX_CONCURRENT_CHECKS)
    notifier: Notifier  # 잠금 해제 · 차단 텔레그램 알림(꺼져 있으면 아무것도 하지 않음)
    clock = staticmethod(time.time)

    # 기본 접근 로그는 끈다 — 의미 있는 사건만 log_event 로 남긴다.
    def log_message(self, format, *args):  # noqa: A002
        pass

    # ── 공통 ──
    @property
    def service(self) -> str:
        return self.headers.get("X-Gate-Service", "").strip()

    @property
    def client_ip(self) -> str:
        return self.headers.get("X-Gate-Client-IP", "").strip() or self.client_address[0]

    def _send(self, status: int, body: bytes, content_type: str, extra: list[tuple[str, str]] = ()) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        # no-referrer 면 브라우저가 폼 POST 의 Origin 을 "null" 로 보내 잠금 해제가 막힌다 — 같은 출처에만 보낸다
        self.send_header("Referrer-Policy", "same-origin")
        if content_type.startswith("text/html"):
            self.send_header("Content-Security-Policy", PAGE_CSP)
            self.send_header("X-Frame-Options", "DENY")
        for name, value in extra:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _page(self, status: int, next_path: str, error: str = "", extra=()) -> None:
        self._send(status, render_page(self.cfg, self.service, next_path, error), "text/html; charset=utf-8", extra)

    def _json(self, status: int, payload: dict, extra=()) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", extra)

    def _cookie_value(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = SimpleCookie()
        try:
            jar.load(raw)
        except CookieError:
            return None
        morsel = jar.get(self.cfg.cookie_name)
        return morsel.value if morsel else None

    def _authorized_as(self) -> str | None:
        token = self._cookie_value()
        if not token or not self.service:
            return None
        name = read_token(self.cfg.secret, token, service=self.service, now=self.clock())
        return name if name in self.cfg.codes else None  # 코드를 지우면 그 쿠키도 바로 무효

    def _set_cookie(self, value: str, max_age: int) -> tuple[str, str]:
        attrs = [f"{self.cfg.cookie_name}={value}", "Path=/", f"Max-Age={max_age}", "HttpOnly", "SameSite=Lax"]
        if self.cfg.cookie_secure:
            attrs.append("Secure")
        return ("Set-Cookie", "; ".join(attrs))

    def _wants_html(self) -> bool:
        method = self.headers.get("X-Forwarded-Method", self.command).upper()
        if method not in ("GET", "HEAD") or self.headers.get("Upgrade"):
            return False
        return "text/html" in self.headers.get("Accept", "")

    # ── GET ──
    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == f"{PREFIX}/healthz":
            return self._send(200, b"ok", "text/plain; charset=utf-8")
        if not self.service or self.service not in self.cfg.services:
            return self._json(403, {"error": "unknown service"})
        if path == f"{PREFIX}/verify":
            return self._verify()
        if path in (PREFIX, f"{PREFIX}/"):
            if self._authorized_as():
                return self._send(303, b"", "text/plain", [("Location", "/")])
            query = parse_qs(urlsplit(self.path).query)
            return self._page(200, safe_next((query.get("next") or ["/"])[0]))
        if path == f"{PREFIX}/lock":
            return self._send(303, b"", "text/plain", [("Location", f"{PREFIX}/"), self._set_cookie("", 0)])
        return self._json(404, {"error": "not found"})

    def _verify(self) -> None:
        if self._authorized_as():
            return self._send(200, b"", "text/plain")
        uri = self.headers.get("X-Forwarded-Uri", "/")
        if self._wants_html():
            return self._page(401, safe_next(uri))
        return self._json(401, {"error": "locked", "message": "접근 코드가 필요합니다", "unlock": f"{PREFIX}/"})

    # ── POST ──
    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if not self.service or self.service not in self.cfg.services:
            return self._json(403, {"error": "unknown service"})
        if path != f"{PREFIX}/unlock":
            return self._json(404, {"error": "not found"})
        if not self._same_origin():
            return self._json(403, {"error": "cross-origin"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_FORM_BYTES:
            return self._json(413, {"error": "too large"})
        form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"), max_num_fields=5)
        next_path = safe_next((form.get("next") or ["/"])[0])
        code = (form.get("code") or [""])[0][:MAX_CODE_CHARS]

        now = self.clock()
        ip = self.client_ip
        wait = self.limiter.begin_attempt(ip, now)  # 확인과 시도 몫 잡기를 한 번에 — 이 뒤로는 반드시 finish · cancel
        if wait > 0:
            log_event("unlock_blocked", service=self.service, ip=ip, wait_s=int(wait))
            return self._page(429, next_path, f"시도가 너무 많습니다. {retry_text(wait)} 다시 시도하세요.",
                              [("Retry-After", str(int(wait) + 1))])
        if not self.checks.acquire(blocking=False):  # 동시 검사 상한 — 기다리게 하지 않는다(기다리는 스레드도 메모리를 쓴다)
            self.limiter.cancel_attempt(ip)
            log_event("unlock_busy", service=self.service, ip=ip)
            return self._page(429, next_path, "지금 잠금 해제 요청이 많습니다. 잠시 뒤에 다시 시도하세요.",
                              [("Retry-After", str(BUSY_RETRY_S))])

        matched = None
        try:
            matched = next((name for name, enc in self.cfg.codes.items() if code and check_code(code, enc)), None)
        finally:
            self.checks.release()
            locks = self.limiter.finish_attempt(ip, now, ok=matched is not None)  # 예외로 끝나도 실패로 센다
            # 잠금이 새로 걸린 이 시도에서만 알린다(알림기는 큐에 넣기만 하고 예외를 내지 않는다)
            if locks.ip_locked:
                self.notifier.locked_ip(self.service, ip, self.headers.get("User-Agent"))
            if locks.global_locked:
                self.notifier.locked_global(self.service)
        if matched is None:
            log_event("unlock_failed", service=self.service, ip=ip)
            return self._page(401, next_path, "접근 코드가 올바르지 않습니다.")

        log_event("unlock_ok", service=self.service, ip=ip, code=matched)
        self.notifier.unlocked(self.service, ip, matched, self.headers.get("User-Agent"))
        token = sign_token(self.cfg.secret, self.service, matched, int(now) + self.cfg.cookie_ttl)
        self._send(303, b"", "text/plain", [("Location", next_path), self._set_cookie(token, self.cfg.cookie_ttl)])

    def _same_origin(self) -> bool:
        """Origin 이 있으면 Host 와 같아야 한다(로그인 CSRF 방지).

        Origin 이 "null" 이면(브라우저 · 확장의 엄격한 Referrer-Policy 로 폼 POST 에서 생긴다) 페이지 스크립트가
        바꿀 수 없는 Sec-Fetch-Site 가 same-origin 일 때만 받는다 — 샌드박스 iframe 같은 다른 사이트의 null 은 거절.
        """
        origin = self.headers.get("Origin")
        if not origin:
            return True
        if origin == "null":
            return self.headers.get("Sec-Fetch-Site", "") == "same-origin"
        return urlsplit(origin).netloc.lower() == self.headers.get("Host", "").lower()


def make_server(cfg: Config, listen: str = "127.0.0.1:8100", limiter: Limiter | None = None,
                max_checks: int = MAX_CONCURRENT_CHECKS, notifier: Notifier | None = None) -> ThreadingHTTPServer:
    host, _, port = listen.rpartition(":")
    handler = type("BoundGateHandler", (GateHandler,), {
        "cfg": cfg, "limiter": limiter or Limiter(), "checks": threading.BoundedSemaphore(max_checks),
        "notifier": notifier or Notifier.from_config(cfg)})
    server = ThreadingHTTPServer((host.strip("[]") or "127.0.0.1", int(port)), handler)
    server.daemon_threads = True
    return server


def main(argv: list[str]) -> int:
    if argv[1:2] == ["hash"]:
        code = sys.stdin.readline().rstrip("\n")
        if len(code) < 8:
            print("접근 코드는 8자 이상이어야 합니다", file=sys.stderr)
            return 2
        print(hash_code(code))
        return 0
    cfg = Config.from_env()
    listen = os.environ.get("GATE_LISTEN", "127.0.0.1:8100")
    server = make_server(cfg, listen)
    log_event("start", listen=listen, services=sorted(cfg.services), codes=len(cfg.codes), telegram=cfg.telegram_on)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
