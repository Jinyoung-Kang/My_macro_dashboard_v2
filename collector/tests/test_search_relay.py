"""
tests/test_search_relay.py
구글 뉴스 경유 주소를 누를 때만 원문 주소로 풀기(ADR 0043 — services/search_relay). 실제 요청 0건 — 경유 쪽(_get)·내부 경로(_post)·예산을
바꿔 끼우고, 표본은 직접 지은 합성 HTML·JSON입니다(구글의 실제 응답이 아님 — 모양 변화는 서버 첫 사용 때 실측).

고정하는 규칙
  1. 옛 모양 ID(풀린 바이트 안에 주소가 통째로)는 요청 없이 풂.
  2. 경유 쪽에 원문 주소가 바로 있으면(data-n-au·meta refresh·구글 밖 canonical·noscript 링크) 요청 한 건.
  3. 새 모양은 서명·시각을 읽어 내부 경로에 한 번 더(요청 두 건, 양식 f.req의 garturlreq).
  4. 동의 화면으로 옮겨지면(3xx)·모양이 바뀌면·풀린 주소가 구글이면 풀지 못함.
  5. 요청마다 하루 예산 한 건(news.google.com/article, 60건), 읽지 못하면 보내지 않음. 거부(공용 래치)는 '풀지 못함'.
"""
from __future__ import annotations

import json
from urllib.parse import parse_qs

import pytest

from app import http
from app.services import search_relay as relay

OLD_ID = "CBMiOWh0dHBzOi8vd3d3LmV4YW1wbGUuY29tL25ld3MvMjAyNi8xMS9zeW50aGV0aWMtc3RvcnkuaHRtbNIBAA"
OLD_TARGET = "https://www.example.com/news/2026/11/synthetic-story.html"
NEW_ID = "CBMiFEFVX3lxTHN5bnRoZXRpYzAwMDAw0gEA"
RELAY = f"https://news.google.com/rss/articles/{NEW_ID}?oc=5"


@pytest.fixture()
def calls(monkeypatch):
    log: dict[str, list] = {"get": [], "post": [], "budget": []}
    monkeypatch.setattr(relay, "_take_budget", lambda: log["budget"].append(1) or True)
    return log


def _signed_page(signature: str = "SYNTHSIG", stamp: str = "1763300000") -> bytes:
    return (f'<html><body><c-wiz><div jscontroller="x" data-n-a-id="{NEW_ID}" data-n-a-ts="{stamp}" data-n-a-sg="{signature}">'
            '</div></c-wiz></body></html>').encode()


def _batch_reply(url: str) -> str:
    inner = json.dumps(["garturlres", url, 1])
    return ")]}'\n\n" + json.dumps([["wrb.fr", "Fbv4je", inner, None, None, None, "generic"], ["di", 42]]) + "\n"


def test_경유_주소의_ID와_그_밖의_주소():
    assert relay.relay_id(RELAY) == NEW_ID
    assert relay.relay_id(f"https://news.google.com/articles/{NEW_ID}") == NEW_ID
    assert relay.relay_id("https://news.google.com/search?q=x") is None
    assert relay.relay_id("https://evil.example.com/rss/articles/CBMiABCDEFGH") is None


def test_옛_모양_경유_id는_요청_없이_푼다(monkeypatch, calls):
    monkeypatch.setattr(relay, "_get", lambda url: pytest.fail("옛 모양은 요청하지 않음"))
    got = relay.resolve(f"https://news.google.com/rss/articles/{OLD_ID}?oc=5")
    assert got == relay.Resolved(OLD_TARGET, 0) and calls["budget"] == []
    assert relay.decode_offline(NEW_ID) is None, "새 모양(AU_yqL…)은 풀린 바이트에 주소가 없음"
    assert relay.decode_offline("!!!not-base64!!!") is None


@pytest.mark.parametrize("page", [
    f'<html><body><div data-n-au="{OLD_TARGET}"></div></body></html>',
    f'<html><head><meta http-equiv="refresh" content="0;url={OLD_TARGET}"></head></html>',
    f'<html><head><link rel="canonical" href="{OLD_TARGET}"></head></html>',
    f'<html><body><a href="https://policies.google.com/x">p</a><noscript><a href="{OLD_TARGET}">open</a></noscript></body></html>',
])
def test_경유_쪽에_원문_주소가_있으면_요청_한_번(monkeypatch, calls, page):
    monkeypatch.setattr(relay, "_get", lambda url: calls["get"].append(url) or (200, page.encode()))
    monkeypatch.setattr(relay, "_post", lambda form: pytest.fail("두 번째 요청은 없음"))
    assert relay.resolve(RELAY) == relay.Resolved(OLD_TARGET, 1)
    assert calls["get"] == [f"https://news.google.com/rss/articles/{NEW_ID}"] and len(calls["budget"]) == 1


def test_새_모양은_서명을_읽고_한_번_더_묻는다(monkeypatch, calls):
    monkeypatch.setattr(relay, "_get", lambda url: calls["get"].append(url) or (200, _signed_page()))
    monkeypatch.setattr(relay, "_post", lambda form: calls["post"].append(form) or (200, _batch_reply(OLD_TARGET)))
    assert relay.resolve(RELAY) == relay.Resolved(OLD_TARGET, 2)
    assert len(calls["budget"]) == 2, "요청마다 예산 한 건"
    outer = json.loads(calls["post"][0]["f.req"])
    assert outer[0][0][0] == "Fbv4je"
    inner = json.loads(outer[0][0][1])
    assert inner[0] == "garturlreq" and inner[2:] == [NEW_ID, 1763300000, "SYNTHSIG"]
    assert parse_qs("f.req=" + calls["post"][0]["f.req"])        # 양식으로 보낼 수 있는 글


def test_동의_화면으로_옮겨지면_풀지_못함(monkeypatch, calls):
    monkeypatch.setattr(relay, "_get", lambda url: (302, b""))
    with pytest.raises(relay.RelayUnresolved) as caught:
        relay.resolve(RELAY)
    assert "동의 화면" in caught.value.message and caught.value.requests == 1 and caught.value.retryable is False


@pytest.mark.parametrize("page", ["<html><body>nothing here</body></html>", "<html><div data-n-a-sg='x' data-n-a-ts='abc'></div></html>"])
def test_모양이_바뀌면_풀지_못함(monkeypatch, calls, page):
    monkeypatch.setattr(relay, "_get", lambda url: (200, page.encode()))
    with pytest.raises(relay.RelayUnresolved) as caught:
        relay.resolve(RELAY)
    assert "모양이 바뀜" in caught.value.message


def test_내부_경로_답의_모양이_바뀌어도_풀지_못함(monkeypatch, calls):
    monkeypatch.setattr(relay, "_get", lambda url: (200, _signed_page()))
    monkeypatch.setattr(relay, "_post", lambda form: (200, ")]}'\n\n[[\"wrb.fr\",\"Fbv4je\",null]]"))
    with pytest.raises(relay.RelayUnresolved) as caught:
        relay.resolve(RELAY)
    assert caught.value.requests == 2


@pytest.mark.parametrize("target", ["https://www.google.com/url?q=x", "https://consent.google.com/m", "https://news.google.com/x",
                                    "javascript:alert(1)", "ftp://example.com/a"])
def test_풀린_주소가_구글이면_쓰지_않는다(monkeypatch, calls, target):
    monkeypatch.setattr(relay, "_get", lambda url: (200, _signed_page()))
    monkeypatch.setattr(relay, "_post", lambda form: (200, _batch_reply(target)))
    with pytest.raises(relay.RelayUnresolved):
        relay.resolve(RELAY)
    assert relay.parse_page(f'<div data-n-au="{target}"></div>') == (None, None)


def test_구글_예산과_공용_래치(monkeypatch):
    seen = []
    monkeypatch.setattr(relay.store, "take_search_budget", lambda host, purpose, day, limit: seen.append((host, purpose, limit)) or False)
    monkeypatch.setattr(relay, "_get", lambda url: pytest.fail("예산이 없으면 보내지 않음"))
    with pytest.raises(relay.RelayUnresolved) as caught:
        relay.resolve(RELAY)
    assert seen == [("news.google.com", "article", 60)] and "60" in caught.value.message
    assert caught.value.reason == "budget", "예산 소진은 사유 budget(계약 §10-3)"

    def broken(*args):
        raise RuntimeError("db down")

    monkeypatch.setattr(relay.store, "take_search_budget", broken)
    with pytest.raises(relay.RelayUnresolved) as caught:
        relay.resolve(RELAY)
    assert "확인하지 못해" in caught.value.message and caught.value.reason == "budget"

    monkeypatch.setattr(relay, "_take_budget", lambda: True)

    def latched(url):
        raise http.SourceRejected("news.google.com", "HTTP 429", latched=True)

    monkeypatch.setattr(relay, "_get", latched)
    with pytest.raises(relay.RelayUnresolved) as caught:
        relay.resolve(RELAY)
    assert caught.value.retryable is True and "거부" in caught.value.message and caught.value.reason == "relay_unresolved"


def test_구글이_래치로_닫혀_있으면_예산을_쓰지_않고_멈춘다(monkeypatch, calls):
    http.reject_host("news.google.com", "HTTP 429")
    monkeypatch.setattr(relay, "_get", lambda url: pytest.fail("닫힌 동안은 보내지 않음"))
    with pytest.raises(relay.RelayUnresolved) as caught:
        relay.resolve(RELAY)
    assert caught.value.retryable is True and calls["budget"] == [] and caught.value.requests == 0


def test_전송_실패는_잠시_뒤_다시(monkeypatch, calls):
    def boom(url):
        raise ConnectionError("reset")

    monkeypatch.setattr(relay, "_get", boom)
    with pytest.raises(relay.RelayUnresolved) as caught:
        relay.resolve(RELAY)
    assert caught.value.retryable is True


def test_경유_세션은_재시도_없는_공용_층():
    session = http.get_relay_session()
    adapter = session.get_adapter("https://news.google.com/")
    assert isinstance(adapter, http._GuardedAdapter) and adapter.max_retries.total == 0
    assert adapter.min_interval == http.DEFAULT_HOST_INTERVAL


# ------------------------------------------------------------------ QA-1038: 지역 인자만 붙여 같은 쪽으로 보내는 302

class _FakeReply:
    def __init__(self, status: int, body: bytes = b"", location: str | None = None) -> None:
        self.status_code = status
        self.headers = {"Location": location} if location is not None else {}
        self._body = body

    def iter_content(self, chunk_size: int = 65536):
        yield self._body

    def close(self) -> None:
        pass


class _FakeSession:
    """경유 세션 자리 — 주는 순서대로 답하고 받은 주소를 적습니다(네트워크 없음)."""

    def __init__(self, replies: list[_FakeReply]) -> None:
        self.replies = list(replies)
        self.seen: list[str] = []

    def get(self, url, **kwargs):
        assert kwargs.get("allow_redirects") is False, "세션이 리다이렉트를 스스로 따라가면 안 됨"
        self.seen.append(url)
        return self.replies.pop(0)


def _direct_page() -> bytes:
    return f'<html><body><div data-n-au="{OLD_TARGET}"></div></body></html>'.encode()


PAGE = f"https://news.google.com/rss/articles/{NEW_ID}"
REAL_GET = relay._get          # conftest가 시험마다 예외로 바꿔 두는 자리 — 가짜 세션을 끼운 시험만 진짜 함수로 되돌립니다(네트워크는 세션이 막음)


def _with_session(monkeypatch, replies: list[_FakeReply]) -> _FakeSession:
    session = _FakeSession(replies)
    monkeypatch.setattr(relay.http, "get_relay_session", lambda: session)
    monkeypatch.setattr(relay.http, "latch_remaining", lambda host: None)
    monkeypatch.setattr(relay, "_get", REAL_GET)
    return session


# 운영 서버(2026-11-27 실측): 경유 쪽 GET이 같은 호스트·같은 경로에 hl·gl·ceid만 붙인 주소로 302. 수정 전에는 3xx를 모두 '동의 화면'으로 보고
# 멈춰, 구글 경유 줄의 본문 보기가 모두 '풀지 못함'이었습니다.
@pytest.mark.xfail(strict=True, reason="QA-1038 재현 — 지역 인자만 붙인 같은 쪽 302를 따라가지 않아 풀지 못함")
def test_QA_1038_지역_인자만_붙인_같은_쪽_302는_한_번_따라간다(monkeypatch, calls):
    session = _with_session(monkeypatch, [_FakeReply(302, location=f"{PAGE}?hl=ko&gl=KR&ceid=KR:ko"), _FakeReply(200, _direct_page())])
    assert relay.resolve(RELAY) == relay.Resolved(OLD_TARGET, 2)
    assert session.seen == [PAGE, f"{PAGE}?ceid=KR%3Ako&gl=KR&hl=ko"], "두 번째 주소는 받은 글이 아니라 검사한 인자로 다시 만든 것"
    assert len(calls["budget"]) == 2, "따라간 요청도 하루 예산 한 건"
