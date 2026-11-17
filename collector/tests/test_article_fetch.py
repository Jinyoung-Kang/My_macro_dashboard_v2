"""
tests/test_article_fetch.py
기사 한 건 받기(ADR 0043 — app/fetch/article). 실제 요청 0건 — 한 홉 보내기(_send_hop)·이름 풀기(addresses._resolve)·호스트 예산을 바꿔 끼웁니다.

고정하는 규칙
  1. 검사한 주소로 고정해 보냄(curl RESOLVE·http·https만·크기 상한, 리다이렉트를 따라가지 않음), User-Agent를 덮어쓰지 않음. 실제 curl 핸들로
     루프백(127.0.0.1)의 시험 서버에 '.invalid' 이름을 고정해 보내 옵션이 libcurl에서 실제로 걸리는지도 봄(바깥 요청·DNS 0건).
  2. 리다이렉트는 홉마다 처음부터 다시 검사하고 3번까지(요청 4건), 내부 주소·규칙 밖·받지 않는 매체로 가는 리다이렉트는 보내지 않음.
  3. 3MB를 넘으면 읽지 않거나 받다가 끊음(too_large), HTML이 아니면 쓰지 않음(not_html).
  4. 403·429·봇 확인 표지는 그 호스트를 이 기능 안에서만 6시간 닫음(공용 세션의 5분 래치는 건드리지 않음), 공용 래치가 닫힌 호스트는 보내지 않음.
  5. 호스트 하루 예산은 홉마다 한 건, 읽지 못하면 보내지 않음. 프록시 환경변수가 있으면 보내지 않음. 남은 시간이 모자라면 보내지 않음.
  6. 로그와 사유 글에 경로·인자가 없음(호스트·상태만).
"""
from __future__ import annotations

import http.server as http_server
import logging
import socket
import socketserver
import threading
import time

import pytest

from app import http
from app.fetch import addresses, article

HTML = b"<!doctype html><html><head><title>t</title></head><body><p>synthetic</p></body></html>"
# 실제 한 홉 보내기 — 모듈을 읽을 때(수집 단계) 잡아 둡니다. 시험이 돌 때는 conftest가 이 자리를 예외로 바꿔 끼워 두므로, 세션을 바꿔 끼운 두 시험만
# 이것을 직접 부릅니다(실제 curl 세션은 만들지 않음).
REAL_SEND_HOP = article._send_hop


@pytest.fixture()
def net(monkeypatch):
    """바꿔 끼운 네트워크 — 이름은 공인 주소로, 홉마다 차례로 줄 답, 보낸 홉 기록, 호스트 예산 기록."""
    for name in article.PROXY_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(addresses, "_resolve", lambda host, port: ["93.184.216.34"])
    monkeypatch.setattr(http, "_sleep", lambda seconds: None)
    sent: list[dict] = []
    replies: list = []
    budget: list[str] = []

    def send(url, *, pin, cookies, timeout):
        sent.append({"url": url, "pin": pin, "cookies": dict(cookies), "timeout": timeout})
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def take(host):
        budget.append(host)
        return True

    monkeypatch.setattr(article, "_send_hop", send)
    monkeypatch.setattr(article, "_take_host_budget", take)
    return type("Net", (), {"sent": sent, "replies": replies, "budget": budget})


def _deadline(seconds: float = 60.0) -> float:
    return time.monotonic() + seconds


def _ok(body: bytes = HTML, content_type: str = "text/html; charset=utf-8", **headers) -> article.Reply:
    return article.Reply(status=200, headers={"content-type": content_type, **headers}, body=body)


def _moved(location: str, status: int = 302, cookies: dict | None = None) -> article.Reply:
    return article.Reply(status=status, headers={"location": location}, body=b"", cookies=cookies or {})


def test_한_건을_받아_마지막_주소와_본문을_돌려준다(net):
    net.replies.append(_ok())
    page = article.fetch_page("https://news.example.com/a/1?x=2#frag", deadline=_deadline())
    assert page.final_url == "https://news.example.com/a/1?x=2" and page.host == "news.example.com"
    assert page.body == HTML and page.hops == 0 and page.status == 200
    assert net.sent[0]["pin"] == "news.example.com:443:93.184.216.34"
    assert net.budget == ["news.example.com"]


def test_검사한_주소로_고정해_보낸다(monkeypatch):
    """실제 _send_hop이 만드는 세션 — 고정 주소(RESOLVE)·http·https만·크기 상한, 리다이렉트를 따라가지 않고 User-Agent를 덮어쓰지 않음."""
    from curl_cffi.const import CurlOpt

    made: list[dict] = []

    class FakeResponse:
        status_code = 200
        headers = {"Content-Type": "text/html"}

    class FakeSession:
        def __init__(self, **kwargs):
            made.append({"init": kwargs})
            self.cookies = {"sid": "abc"}

        def request(self, method, url, **kwargs):
            made[-1]["request"] = (method, url, kwargs)
            kwargs["content_callback"](b"<html>")
            return FakeResponse()

        def close(self):
            made[-1]["closed"] = True

    monkeypatch.setattr(article.curl_requests, "Session", FakeSession)
    reply = REAL_SEND_HOP("https://news.example.com/a", pin="news.example.com:443:93.184.216.34", cookies={}, timeout=(5.0, 15.0))
    init = made[0]["init"]
    assert init["curl_options"][CurlOpt.RESOLVE] == ["news.example.com:443:93.184.216.34"]
    assert init["curl_options"][CurlOpt.PROTOCOLS_STR] == "http,https"
    assert init["curl_options"][CurlOpt.MAXFILESIZE_LARGE] == article.MAX_BYTES
    assert set(init["curl_options"]) == {CurlOpt.RESOLVE, CurlOpt.PROTOCOLS_STR, CurlOpt.MAXFILESIZE_LARGE}, \
        "libcurl이 거절하는 옵션(ALTSVC_CTRL 0 등)을 더하지 않음 — 아래 루프백 시험이 실제 핸들로 확인"
    assert init["impersonate"].startswith("chrome")
    method, url, kwargs = made[0]["request"]
    assert (method, url) == ("GET", "https://news.example.com/a")
    assert kwargs["allow_redirects"] is False
    assert "User-Agent" not in kwargs["headers"] and "Referer" not in kwargs["headers"]
    assert kwargs["headers"]["Accept"] == article.ACCEPT
    assert made[0]["closed"] is True
    assert reply.status == 200 and reply.body == b"<html>" and reply.cookies == {"sid": "abc"}


def test_리다이렉트는_홉마다_다시_검사하고_3번까지(net):
    net.replies.extend([_moved("/b", cookies={"k": "v"}), _moved("https://www.example.org/c", 301), _moved("https://www.example.org/d", 308),
                        _ok()])
    page = article.fetch_page("https://news.example.com/a", deadline=_deadline())
    assert [hop["url"] for hop in net.sent] == ["https://news.example.com/a", "https://news.example.com/b",
                                                 "https://www.example.org/c", "https://www.example.org/d"]
    assert net.sent[1]["cookies"] == {"k": "v"}, "같은 호스트의 다음 홉에만 쿠키"
    assert net.sent[2]["cookies"] == {}, "다른 호스트로는 쿠키를 넘기지 않음"
    assert net.budget == ["news.example.com", "news.example.com", "www.example.org", "www.example.org"], "예산은 홉마다"
    assert page.hops == 3 and page.final_url == "https://www.example.org/d"

    net.sent.clear()
    net.replies.extend([_moved("/1"), _moved("/2"), _moved("/3"), _moved("/4")])
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/0", deadline=_deadline())
    assert caught.value.reason == "bad_redirect" and len(net.sent) == 4


@pytest.mark.parametrize("location,reason", [
    ("http://10.0.0.5/admin", "bad_redirect"),
    ("http://169.254.169.254/latest/meta-data/", "bad_redirect"),
    ("http://postgres:5432/", "bad_redirect"),
    ("ftp://news.example.com/file", "bad_redirect"),
    ("https://news.example.com:8443/x", "bad_redirect"),
    ("https://finance.yahoo.com/news/x", "refused_host"),
])
def test_내부_주소로_가는_리다이렉트는_보내지_않는다(net, location, reason):
    net.replies.append(_moved(location))
    refused = {"finance.yahoo.com": "Yahoo 글은 받지 않습니다"}
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline(), refused=refused.get)
    assert caught.value.reason == reason
    assert len(net.sent) == 1, "두 번째 홉은 보내지 않음"


def test_이름이_내부_주소로_풀리는_리다이렉트도_보내지_않는다(net, monkeypatch):
    monkeypatch.setattr(addresses, "_resolve", lambda host, port: ["10.1.2.3"] if host == "evil.example.net" else ["93.184.216.34"])
    net.replies.append(_moved("https://evil.example.net/x"))
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline())
    assert caught.value.reason == "unsafe_address" and len(net.sent) == 1


def test_시작_주소가_내부_주소면_보내지_않는다(net, monkeypatch):
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("http://127.0.0.1:80/", deadline=_deadline())
    assert caught.value.reason == "unsafe_address"
    monkeypatch.setattr(addresses, "_resolve", lambda host, port: ["fd7a:115c:a1e0::5"])
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://tailnet.example.com/", deadline=_deadline())
    assert caught.value.reason == "unsafe_address"
    assert net.sent == [] and net.budget == []


def test_3MB를_넘으면_읽지_않거나_받다가_끊는다(net):
    net.replies.append(article.ArticleFetchError("too_large", "페이지가 3MB를 넘어 받지 않았습니다", host="news.example.com", sent=True))
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline())
    assert caught.value.reason == "too_large" and caught.value.sent is True
    assert article.MAX_BYTES == 3_000_000


def test_받는_도중_상한을_넘으면_curl이_끊는다(monkeypatch):
    """실제 _send_hop의 content_callback — 압축을 푼 바이트를 세다가 상한을 넘는 순간 끊고 too_large."""
    from curl_cffi.requests import exceptions as curl_exceptions

    class FakeSession:
        def __init__(self, **kwargs):
            self.cookies = {}

        def request(self, method, url, **kwargs):
            take = kwargs["content_callback"]
            for _ in range(4):
                if take(b"x" * 1_000_000) != 1_000_000:
                    raise curl_exceptions.RequestException("write error", 23)
            raise AssertionError("상한을 넘었는데 끊지 않음")

        def close(self):
            pass

    monkeypatch.setattr(article.curl_requests, "Session", FakeSession)
    with pytest.raises(article.ArticleFetchError) as caught:
        REAL_SEND_HOP("https://news.example.com/a", pin="news.example.com:443:93.184.216.34", cookies={}, timeout=(5.0, 15.0))
    assert caught.value.reason == "too_large"


@pytest.mark.parametrize("content_type,body,ok", [
    ("application/pdf", b"%PDF-1.7", False),
    ("application/json", b"{}", False),
    ("", b"<!DOCTYPE html><html><body>x</body></html>", True),
    ("", b"plain words", False),
    ("application/xhtml+xml; charset=utf-8", b"<html/>", True),
])
def test_HTML이_아니면_쓰지_않는다(net, content_type, body, ok):
    net.replies.append(_ok(body=body, content_type=content_type))
    if ok:
        assert article.fetch_page("https://news.example.com/a", deadline=_deadline()).body == body
    else:
        with pytest.raises(article.ArticleFetchError) as caught:
            article.fetch_page("https://news.example.com/a", deadline=_deadline())
        assert caught.value.reason == "not_html"


@pytest.mark.parametrize("reply", [
    article.Reply(status=403, headers={}, body=b"denied"),
    article.Reply(status=429, headers={"retry-after": "30"}, body=b""),
    article.Reply(status=200, headers={"content-type": "text/html", "cf-mitigated": "challenge"}, body=HTML),
    article.Reply(status=503, headers={"content-type": "text/html"}, body=b"<title>Just a moment...</title>"),
])
def test_403_429_차단_표지는_그_호스트를_6시간_닫고_공용_래치는_건드리지_않는다(net, reply):
    net.replies.append(reply)
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline())
    assert caught.value.reason == "blocked" and caught.value.sent is True
    left, _ = article.blocked_reason("news.example.com")
    assert 5.9 * 3600 < left <= 6 * 3600
    assert caught.value.hold == pytest.approx(6 * 3600), "닫은 시간을 실어 보냄(부르는 쪽이 그만큼 캐시)"
    assert http.latch_remaining("news.example.com") is None, "공용 세션의 5분 래치는 부르지 않음"
    with pytest.raises(article.ArticleFetchError) as again:
        article.fetch_page("https://news.example.com/other", deadline=_deadline())
    assert again.value.reason == "blocked" and len(net.sent) == 1, "닫힌 동안은 보내지 않음"
    assert 5.9 * 3600 < again.value.hold <= 6 * 3600, "닫힘에 걸린 실패도 남은 초를 실어 보냄"


def test_Retry_After가_더_길면_그만큼_닫되_24시간까지(net):
    net.replies.append(article.Reply(status=429, headers={"retry-after": str(30 * 3600)}, body=b""))
    with pytest.raises(article.ArticleFetchError):
        article.fetch_page("https://news.example.com/a", deadline=_deadline())
    left, _ = article.blocked_reason("news.example.com")
    assert 23.9 * 3600 < left <= 24 * 3600


def test_공용_래치가_닫힌_호스트는_보내지_않는다(net):
    http.reject_host("news.example.com", "HTTP 429")
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline())
    assert caught.value.reason == "blocked" and net.sent == [] and net.budget == []


@pytest.mark.parametrize("status,reason,retryable", [
    (401, "blocked", False), (402, "blocked", False), (451, "blocked", False),
    (404, "http_error", False), (410, "http_error", False), (400, "http_error", False),
    (500, "http_error", True), (502, "http_error", True), (304, "http_error", False),
])
def test_상태_코드별_판정(net, status, reason, retryable):
    net.replies.append(article.Reply(status=status, headers={"content-type": "text/html"}, body=HTML))
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline())
    assert (caught.value.reason, caught.value.retryable, caught.value.status) == (reason, retryable, status)
    assert article.blocked_reason("news.example.com") is None, "403·429·표지가 아니면 호스트를 닫지 않음"


def test_호스트_하루_예산은_홉마다(net, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(article, "_take_host_budget", lambda host: calls.append(host) or len(calls) < 2)
    net.replies.extend([_moved("/b"), _ok()])
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline())
    assert caught.value.reason == "budget" and len(net.sent) == 1 and len(calls) == 2
    assert "news.example.com" in caught.value.message and str(article.HOST_DAILY_BUDGET) in caught.value.message


def test_예산을_읽지_못하면_보내지_않는다(net, monkeypatch):
    def broken(host):
        raise RuntimeError("db down")

    monkeypatch.setattr(article, "_take_host_budget", broken)
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline())
    assert caught.value.reason == "budget" and net.sent == []


def test_호스트_예산은_표_fetch_budgets의_용도_article(monkeypatch):
    seen = []
    monkeypatch.setattr(article.store, "take_search_budget", lambda host, purpose, day, limit: seen.append((host, purpose, limit)) or True)
    assert article._take_host_budget("news.example.com") is True
    assert seen == [("news.example.com", "article", 20)]


@pytest.mark.parametrize("name", ["HTTPS_PROXY", "http_proxy", "ALL_PROXY"])
def test_프록시_환경변수가_있으면_보내지_않는다(net, monkeypatch, name):
    monkeypatch.setenv(name, "http://proxy.invalid:3128")
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline())
    assert caught.value.reason == "server_only" and net.sent == [] and net.budget == []


def test_남은_시간이_모자라면_보내지_않는다(net):
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/a", deadline=_deadline(3.0))
    assert caught.value.reason == "timeout" and caught.value.retryable is True and net.sent == []


def test_시간_상한은_남은_시간에_맞춰_줄인다(net):
    net.replies.append(_ok())
    article.fetch_page("https://news.example.com/a", deadline=_deadline(11.0))
    connect, read = net.sent[0]["timeout"]
    assert connect + read <= 10.0 + 1e-6 and connect > 0 and read > 0


def test_로그와_사유에_경로·인자가_없다(net, caplog):
    caplog.set_level(logging.INFO)
    net.replies.extend([_moved("/next?token=SECRETPATH"), article.Reply(status=404, headers={}, body=b"")])
    with pytest.raises(article.ArticleFetchError) as caught:
        article.fetch_page("https://news.example.com/private/SECRETPATH?q=SECRETQUERY", deadline=_deadline())
    text = caplog.text + caught.value.message
    assert "SECRETPATH" not in text and "SECRETQUERY" not in text and "/private" not in text
    assert "news.example.com" in caught.value.message


# ------------------------------------------------------------------ 실제 curl 핸들(루프백만)

class _LoopbackHandler(http_server.BaseHTTPRequestHandler):
    """시험 서버 — 받은 요청의 경로·Host·User-Agent를 적고 경로마다 정한 답을 줍니다."""

    seen: list[dict] = []

    def log_message(self, *args):  # 시험 출력에 접속 기록을 남기지 않음
        pass

    def do_GET(self):
        type(self).seen.append({"path": self.path, "host": self.headers.get("Host"), "ua": self.headers.get("User-Agent") or ""})
        if self.path == "/ok":
            body = HTML
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Set-Cookie", "sid=abc; Path=/")
            self.send_header("Alt-Svc", 'h2="127.0.0.1:1"; ma=86400')
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/moved":
            self.send_response(302)
            self.send_header("Location", "/ok")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == "/big-length":
            body = b"x" * 5000
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/big-chunked":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for _ in range(10):
                chunk = b"y" * 1000
                self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()


@pytest.fixture()
def loopback(monkeypatch):
    """127.0.0.1의 빈 포트에 띄운 시험 서버 — 고정 이름 'pinned.invalid'(예약 이름이라 DNS로 풀리지 않음)를 이 주소로 고정해 부릅니다."""
    for name in (*article.PROXY_ENV, "NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    _LoopbackHandler.seen = []
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _LoopbackHandler)
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    port = server.server_address[1]
    try:
        yield type("Loopback", (), {"port": port, "pin": f"pinned.invalid:{port}:127.0.0.1",
                                    "url": lambda path: f"http://pinned.invalid:{port}{path}", "seen": _LoopbackHandler.seen})
    finally:
        server.shutdown()
        server.server_close()


def test_실제_curl_핸들이_고정_주소로_한_번_보낸다(loopback):
    """옵션이 libcurl에서 실제로 걸림(설정 단계 실패 없음), 이름 풀기 없이 고정 주소로 감, 쿠키·머리글을 돌려줌, User-Agent는 브라우저 프로필 그대로."""
    reply = REAL_SEND_HOP(loopback.url("/ok"), pin=loopback.pin, cookies={}, timeout=(5.0, 5.0))
    assert reply.status == 200 and reply.body == HTML
    assert reply.headers["content-type"].startswith("text/html") and reply.cookies == {"sid": "abc"}
    assert loopback.seen == [{"path": "/ok", "host": f"pinned.invalid:{loopback.port}", "ua": loopback.seen[0]["ua"]}]
    assert "Chrome" in loopback.seen[0]["ua"], "User-Agent를 덮어쓰지 않음(브라우저 프로필 그대로)"


def test_실제_curl_핸들은_리다이렉트를_따라가지_않는다(loopback):
    reply = REAL_SEND_HOP(loopback.url("/moved"), pin=loopback.pin, cookies={}, timeout=(5.0, 5.0))
    assert reply.status == 302 and reply.headers["location"] == "/ok" and reply.body == b""
    assert [hit["path"] for hit in loopback.seen] == ["/moved"], "요청은 하나 — 목적지는 fetch_page가 다시 검사한 뒤에만"


@pytest.mark.parametrize("path", ["/big-length", "/big-chunked"])
def test_실제_curl_핸들은_상한을_넘으면_끊는다(loopback, monkeypatch, path):
    """Content-Length가 상한을 넘을 때(MAXFILESIZE)와 길이 없이 흘려 보낼 때(받는 도중 셈) 모두 too_large."""
    monkeypatch.setattr(article, "MAX_BYTES", 2000)
    with pytest.raises(article.ArticleFetchError) as caught:
        REAL_SEND_HOP(loopback.url(path), pin=loopback.pin, cookies={}, timeout=(5.0, 5.0))
    assert caught.value.reason == "too_large" and caught.value.sent is True


def test_실제_curl_핸들이_닫힌_포트면_transport(loopback):
    """고정한 주소의 포트에 아무도 없으면 연결 실패(transport) — 다른 주소로 다시 풀지 않음."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed = probe.getsockname()[1]
    with pytest.raises(article.ArticleFetchError) as caught:
        REAL_SEND_HOP(f"http://pinned.invalid:{closed}/ok", pin=f"pinned.invalid:{closed}:127.0.0.1", cookies={}, timeout=(2.0, 2.0))
    assert caught.value.reason == "transport" and caught.value.retryable is True
    assert loopback.seen == []


def test_세션_옵션을_걸지_못하면_보내지_않은_transport(monkeypatch):
    """요청 오류가 아닌 curl 오류(설정 단계 — 예: libcurl이 거절하는 옵션 값)도 transport로 — 작업자의 일반 예외까지 올라가지 않고, sent는 거짓."""
    from curl_cffi.curl import CurlError

    class BrokenSession:
        def __init__(self, **kwargs):
            self.cookies = {}

        def request(self, method, url, **kwargs):
            raise CurlError("Failed to setopt 286 0, curl: (43) setopt 0x11e got bad argument", 43)

        def close(self):
            pass

    monkeypatch.setattr(article.curl_requests, "Session", BrokenSession)
    with pytest.raises(article.ArticleFetchError) as caught:
        REAL_SEND_HOP("https://news.example.com/a", pin="news.example.com:443:93.184.216.34", cookies={}, timeout=(5.0, 15.0))
    assert (caught.value.reason, caught.value.sent, caught.value.retryable) == ("transport", False, True)
