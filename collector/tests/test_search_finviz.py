"""
tests/test_search_finviz.py
정보 검색 단계 5 — Finviz 종목 뉴스(ADR 0041 결정 10, 계약 §8-1~§8-4·§8-7 — services/search_finviz).

고정하는 규칙
  1. 호스트 정책: finviz.com 계층 1 → 2, 계층 예산 250, 용도별 search 60·watch 100. 브라우저 허용 목록은 test_fetch_browser_client가 대조.
  2. 줄 만들기(순수 함수): 뉴스 표(id="news-table")만, 최대 100줄. 날짜 칸 'Nov-13-26 11:24PM'은 그 날, '10:40PM'은 앞 줄의 날짜, 'Today'는
     미국 동부의 오늘 — 시각은 미국 동부(서머타임 포함)를 UTC ISO로. 날짜를 모르는 줄은 시각 모름. 상대 주소는 https://finviz.com + 경로,
     매체는 괄호를 뗀 글, id는 info_text.item_id(주소). 표가 없거나 줄을 하나도 읽지 못하면 '형식이 바뀜', 깨진 링크 한 줄은 그 줄만 건너뜀.
  3. 서버에서만: POLITE_FETCH_ENABLED가 꺼진 곳은 줄에 넣지 않고 server_only — 예산·계층·네트워크 0건. 외부를 끈 요청은 캐시만(offline).
  4. 줄 세우기: 과정 하나에 작업자 하나, finviz.com에 동시에 두 건이 나가지 않음(관심 대상 수집도 같은 잠금). 같은 티커는 줄에 하나,
     줄 상한 5, 줄에 넣기 전에 검색 예산 한 건(자리를 먼저 잡고, 그 사이 끝난 결과는 예산 없이 씀). 성공 30분·실패 5분 캐시(잠금을 기다리는
     사이 다른 길이 남긴 실패도). 작업에는 시간 상한(300초), 관심 대상 수집은 계층 한 번 올림에 필요한 시간이 남을 때만.
  5. 판정: 계층 예산(FetchSkipped)은 '예산 소진', 거부는 error + 새로 거부당했을 때만 끊김 알림(search_watch 판정 blocked), 형식이 바뀌면
     '형식이 바뀜', 종목 화면이 아닌 곳으로 옮겨진 답은 쓰지 않음. 닫힌 호스트는 줄에 넣지 않고 예산도 쓰지 않음. 통과 계층이 browser여도
     즉석 검색은 보냄(브라우저 컨테이너 호출은 계층이 과정 안에서 한 줄로 세움).
  6. 사유 글·로그에 티커·경로·인자가 남지 않음.

외부 네트워크·DB를 쓰지 않습니다(계층 ladder.fetch와 저장소 함수를 바꿔 끼움). 합성 HTML만 씁니다(실제 Finviz 응답 원문 없음).
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import date, datetime, timezone

import pytest

from app import http, store
from app.fetch import browser_client, impersonate, ladder, policy, state
from app.services import info_text
from app.services import search_finviz as finviz
from app.services import search_rules as rules
from app.tasks import polite
from app.tasks import search_watch as watch_task

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)      # 미국 동부 2026-11-14 07:00(표준시)
TICKER = "QZXY"


def _news_row(stamp: str, title: str, href: str, publisher: str | None) -> str:
    right = f'<div class="news-link-right flex gap-1 items-center"><span>({publisher})</span></div>' if publisher else ""
    return (f'<tr class="cursor-pointer has-label"><td width="130" align="right">{stamp}</td>'
            f'<td align="left"><div class="news-link-container"><div class="news-link-left">'
            f'<a class="tab-link-news" href="{href}" target="_blank" rel="nofollow">{title}</a></div>{right}</div></td></tr>')


def _page(rows: list[str], *, table_id: str = "news-table") -> str:
    return (f'<html><head><title>Synthetic quote</title></head><body><table class="snapshot-table2"><tr><td>P/E</td></tr></table>'
            f'<table width="100%" id="{table_id}" class="fullview-news-outer news-table">{"".join(rows)}</table></body></html>')


SIMPLE = _page([_news_row("Nov-13-26 11:24PM", "Synthetic Corp beats estimates", "https://www.example.com/a1", "Synthetic Wire")])


# ==============================================================================
# 1. 호스트 정책
# ==============================================================================
def test_finviz_호스트_정책과_용도별_예산():
    rules_ = policy.POLICIES["finviz.com"]
    assert rules_.tiers == (policy.TIER_IMPERSONATE, policy.TIER_BROWSER) and rules_.daily_budget == 250
    assert "www.finviz.com" not in policy.POLICIES, "리디렉트로 다른 호스트가 나오면 표에 없어 실패로 끝남(넓히지 않음)"
    assert (finviz.HOST, finviz.SEARCH_BUDGET, finviz.WATCH_BUDGET) == ("finviz.com", 60, 100)
    assert finviz.SEARCH_BUDGET + finviz.WATCH_BUDGET <= rules_.daily_budget
    assert (finviz.SUCCESS_TTL, finviz.FAILURE_TTL, finviz.QUEUE_LIMIT, finviz.JOB_DEADLINE) == (1800.0, 300.0, 5, 300.0)
    assert watch_task.DAILY_BUDGETS[finviz.HOST] == finviz.WATCH_BUDGET
    assert finviz.BLOCKED_STALE_MINUTES == int(watch_task.CADENCE.high_minutes * polite.STALE_FACTOR), \
        "끊김 알림의 '오래 못 받음' 간격은 관심 대상 수집과 같은 값"


def test_종목_화면_주소는_티커_한_쪽뿐이고_점은_줄표로():
    assert finviz.quote_url("NVDA") == "https://finviz.com/quote.ashx?t=NVDA"
    assert finviz.quote_url("BRK.B") == "https://finviz.com/quote.ashx?t=BRK-B"


# ==============================================================================
# 2. 줄 만들기
# ==============================================================================
def test_날짜_칸은_앞_줄의_날짜를_이어받고_시각은_미국_동부():
    markup = _page([
        _news_row("Today 06:40AM", "Synthetic Corp opens plant", "https://www.example.com/a1", "Synthetic Wire"),
        _news_row("05:02AM", "Synthetic Corp early note", "https://www.example.org/a2", "Example Daily"),
        _news_row("Nov-13-26 11:24PM", "Synthetic Corp late filing", "https://example.net/a3?ref=x", "Example Markets"),
        _news_row("10:40PM", "Synthetic note on Finviz", "/news/123456/synthetic-note", "Synthetic Blog"),
        _news_row("Jul-01-26 09:30AM", "Synthetic Corp summer story", "https://www.example.com/a5", "Synthetic Wire"),
        _news_row("12:05AM", "Synthetic Corp midnight story", "https://www.example.com/a6", "Synthetic Wire"),
        _news_row("Dec-31-25 12:30PM", "S&amp;P adds Synthetic Corp", "https://www.example.com/a7", "Example Index"),
    ])
    items = finviz.parse_news_table(markup, now=NOW)
    stamps = [(item["title"], item["publishedAt"]) for item in items]
    assert stamps == [
        ("Synthetic Corp opens plant", "2026-11-14T11:40:00+00:00"),          # Today = 동부의 오늘(11-14)
        ("Synthetic Corp early note", "2026-11-14T10:02:00+00:00"),           # 앞 줄(Today)의 날짜
        ("Synthetic Corp late filing", "2026-11-14T04:24:00+00:00"),          # 표준시(UTC-5)
        ("Synthetic note on Finviz", "2026-11-14T03:40:00+00:00"),            # 앞 줄의 날짜(11-13)
        ("Synthetic Corp summer story", "2026-07-01T13:30:00+00:00"),         # 서머타임(UTC-4)
        ("Synthetic Corp midnight story", "2026-07-01T04:05:00+00:00"),       # 12:05AM = 00:05
        ("S&P adds Synthetic Corp", "2025-12-31T17:30:00+00:00"),             # 12:30PM = 12:30
    ]
    first = items[0]
    assert first == {"id": info_text.item_id("https://www.example.com/a1"), "kind": "news", "title": "Synthetic Corp opens plant",
                     "url": "https://www.example.com/a1", "publisher": "Synthetic Wire", "publisherDomain": "example.com",
                     "publishedAt": "2026-11-14T11:40:00+00:00", "timeBasis": "published", "source": "finviz", "lang": "en",
                     "summary": None, "readerId": None}
    inner = items[3]
    assert inner["url"] == "https://finviz.com/news/123456/synthetic-note" and inner["publisherDomain"] == "finviz.com"
    assert inner["publisher"] == "Synthetic Blog" and inner["id"] == info_text.item_id(inner["url"])
    assert items[2]["publisherDomain"] == "example.net"


def test_날짜를_모르는_줄은_시각_모름이고_이어받지_않는다():
    markup = _page([
        _news_row("11:00AM", "Synthetic Corp no date yet", "https://www.example.com/b1", "Synthetic Wire"),
        _news_row("Nov-12-26 08:00AM", "Synthetic Corp dated", "https://www.example.com/b2", "Synthetic Wire"),
        _news_row("Xyz-99-26 08:00AM", "Synthetic Corp garbled", "https://www.example.com/b3", "Synthetic Wire"),
        _news_row("07:00AM", "Synthetic Corp after garbled", "https://www.example.com/b4", None),
    ])
    items = {item["title"]: item for item in finviz.parse_news_table(markup, now=NOW)}
    assert items["Synthetic Corp no date yet"]["publishedAt"] is None
    assert items["Synthetic Corp dated"]["publishedAt"] == "2026-11-12T13:00:00+00:00"
    assert items["Synthetic Corp garbled"]["publishedAt"] is None
    assert items["Synthetic Corp after garbled"]["publishedAt"] is None, "읽지 못한 날짜 뒤의 시각만 줄은 날짜를 지어내지 않음"
    assert items["Synthetic Corp after garbled"]["publisher"] is None
    kept, dropped, _ = rules.apply_rules(list(items.values()), start=rules.window_start(rules.kst_today(NOW)), now=NOW)
    assert dropped["noTime"] == 3 and [item["title"] for item in kept] == ["Synthetic Corp dated"]


def test_링크_없는_줄은_건너뛰되_날짜는_이어받는다():
    markup = _page([
        '<tr><td width="130" align="right">Nov-10-26 09:00AM</td><td align="left"><div>Sponsored</div></td></tr>',
        _news_row("10:15AM", "Synthetic Corp after ad", "https://www.example.com/c1", "Synthetic Wire"),
        _news_row("11:15AM", "Script link", "javascript:void(0)", "Synthetic Wire"),
    ])
    items = finviz.parse_news_table(markup, now=NOW)
    assert [(item["title"], item["publishedAt"]) for item in items] == [("Synthetic Corp after ad", "2026-11-10T15:15:00+00:00")]


def test_줄은_100개까지():
    rows = [_news_row("Nov-13-26 11:24PM" if n == 0 else "10:00PM", f"Synthetic story {n}", f"https://www.example.com/s{n}",
                      "Synthetic Wire") for n in range(130)]
    assert len(finviz.parse_news_table(_page(rows), now=NOW)) == finviz.MAX_ROWS == 100


def test_뉴스_표가_없거나_줄을_읽지_못하면_형식이_바뀜():
    with pytest.raises(finviz.ShapeError):
        finviz.parse_news_table(_page([_news_row("Nov-13-26 11:24PM", "x", "https://www.example.com/x", "y")], table_id="other"),
                                now=NOW)
    with pytest.raises(finviz.ShapeError):
        finviz.parse_news_table(_page(['<tr><td>Nov-13-26 11:24PM</td><td>no link</td></tr>']), now=NOW)
    with pytest.raises(finviz.ShapeError):
        finviz.parse_news_table("", now=NOW)
    assert finviz.parse_news_table(_page([]), now=NOW) == [], "빈 표는 빈 결과(형식은 그대로)"


# ==============================================================================
# 3·4·5. 즉석 검색의 줄 세우기
# ==============================================================================
class Network:
    """계층(ladder.fetch)과 저장소(예산·끊김 알림) 자리 — 부른 것을 적고, 필요하면 받는 도중에 멈춰 둡니다."""

    def __init__(self, monkeypatch):
        self.urls: list[str] = []
        self.expects: list[str] = []
        self.time_left: list[float | None] = []
        self.pages: dict[str, object] = {}
        self.gate: threading.Event | None = None
        self.started = threading.Event()
        self.active = 0
        self.max_active = 0
        self.budget_calls: list[tuple] = []
        self.budget_left = finviz.SEARCH_BUDGET
        self.blocked: list[tuple] = []
        self.final_urls: dict[str, str] = {}
        self.host_row: dict | None = None        # 표 fetch_hosts의 finviz.com 줄(닫힘·통과한 계층)
        self._lock = threading.Lock()
        monkeypatch.setattr(ladder, "fetch", self.fetch)
        monkeypatch.setattr(store, "take_search_budget", self.take)
        monkeypatch.setattr(store, "note_source_state", self.note)
        monkeypatch.setattr(store, "fetch_host", lambda host: self.host_row if host == finviz.HOST else None)

    def fetch(self, url, *, expect=policy.EXPECT_HTML, **kwargs):
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            self.urls.append(url)
            self.expects.append(expect)
            self.time_left.append(http.time_left())
            self.started.set()
            if self.gate is not None:
                assert self.gate.wait(5), "시험이 멈춘 요청을 풀지 않았습니다"
            time.sleep(0.02)
            answer = self.pages.get(url, SIMPLE)
            if isinstance(answer, BaseException):
                raise answer
            return ladder.Fetched(url=url, status=200, content_type="text/html; charset=utf-8", body=str(answer).encode("utf-8"),
                                  tier=policy.TIER_IMPERSONATE, final_url=self.final_urls.get(url, url))
        finally:
            with self._lock:
                self.active -= 1

    def take(self, host, purpose, day, limit):
        self.budget_calls.append((host, purpose, day, limit))
        if self.budget_left <= 0:
            return False
        self.budget_left -= 1
        return True

    def note(self, task, status, reason, *, stale_after_minutes, when=None):
        self.blocked.append((task, status, reason, stale_after_minutes))


@pytest.fixture()
def net(monkeypatch):
    finviz.reset()
    monkeypatch.setattr(finviz, "_now", lambda: NOW)
    network = Network(monkeypatch)
    yield network
    if network.gate is not None:
        network.gate.set()
    finviz.wait_idle(5)
    finviz.reset()


def _ask(ticker=TICKER, **kwargs):
    return finviz.request(ticker, **{"external": True, "allow_queue": True, **kwargs})


def test_처음_부름은_줄에_넣고_받는_중_받은_뒤에는_받음_그다음은_캐시(net):
    first = _ask()
    assert (first.status, first.queued, first.message) == ("pending", True, "받는 중 — 몇 초 뒤 채움")
    assert finviz.wait_idle(5)
    assert net.urls == ["https://finviz.com/quote.ashx?t=QZXY"] and net.expects == [policy.EXPECT_HTML]
    assert net.budget_calls == [("finviz.com", "search", rules.kst_today(), 60)], "줄에 넣기 전 검색 예산 한 건(KST 날짜)"
    done = _ask()
    assert (done.status, done.queued) == ("ok", False) and [item["title"] for item in done.items] == ["Synthetic Corp beats estimates"]
    again = _ask()
    assert again.status == "cached" and len(again.items) == 1
    assert len(net.urls) == 1 and len(net.budget_calls) == 1, "30분 안에는 다시 받지 않음"


def test_같은_티커는_줄에_하나이고_받는_동안은_받는_중(net):
    net.gate = threading.Event()
    assert _ask().queued is True
    assert net.started.wait(5)
    second = _ask()
    assert (second.status, second.queued) == ("pending", False)
    assert len(net.budget_calls) == 1, "줄에 있는 티커는 예산을 다시 쓰지 않음"
    net.gate.set()
    assert finviz.wait_idle(5) and len(net.urls) == 1


def test_줄_상한은_5이고_넘으면_대기열이_가득_참(net):
    net.gate = threading.Event()
    tickers = ["SYNA", "SYNB", "SYNC", "SYND", "SYNE"]
    assert all(_ask(ticker).queued for ticker in tickers)
    full = _ask("SYNF")
    assert (full.status, full.queued) == ("skipped", False) and "대기열이 가득 참" in full.message
    assert len(net.budget_calls) == 5, "가득 찬 줄에는 예산을 쓰지 않음"
    net.gate.set()
    assert finviz.wait_idle(5)
    assert net.max_active == 1, "작업자 하나 — finviz.com에 동시에 두 건이 나가지 않음"


def test_작업에는_시간_상한이_걸린다(net):
    _ask()
    assert finviz.wait_idle(5)
    left = net.time_left[0]
    assert left is not None and 0 < left <= finviz.JOB_DEADLINE


def test_새로_부르기_한도를_넘으면_줄에_넣지_않고_받아_둔_결과만(net):
    limited = _ask(allow_queue=False)
    assert (limited.status, limited.queued) == ("skipped", False)
    assert limited.message == "한 사람이 한 시간에 Finviz를 새로 부를 수 있는 횟수를 넘음 — 받아 둔 결과만"
    assert net.budget_calls == [] and net.urls == []
    _ask()
    assert finviz.wait_idle(5)
    assert _ask(allow_queue=False).status in ("ok", "cached"), "캐시는 그대로 씀"


def test_검색_예산이_없으면_줄에_넣지_않는다(net):
    net.budget_left = 0
    answer = _ask()
    assert (answer.status, answer.message, answer.queued) == ("skipped", "오늘 Finviz 검색 예산 소진", False)
    assert finviz.wait_idle(1) and net.urls == []


def test_서버가_아니면_줄에_넣지_않고_예산·계층·네트워크_0건(net, monkeypatch):
    monkeypatch.delenv(polite.ENV_ENABLED, raising=False)
    answer = _ask()
    assert (answer.status, answer.message, answer.queued) == ("server_only", "Finviz는 운영 서버에서만", False)
    assert finviz.wait_idle(1)
    assert net.urls == [] and net.budget_calls == [] and net.blocked == []
    watched = finviz.for_watch(TICKER, take=lambda: pytest.fail("서버가 아니면 예산도 쓰지 않음"))
    assert watched.sent is False and watched.items == () and net.urls == []


def test_외부를_끈_요청은_캐시만(net):
    offline = _ask(external=False)
    assert offline.status == "offline" and net.budget_calls == [] and net.urls == []
    _ask()
    assert finviz.wait_idle(5)
    cached = _ask(external=False)
    assert cached.status == "cached" and len(cached.items) == 1


def test_계층_예산이_바닥나면_예산_소진이고_5분_캐시(net, monkeypatch):
    net.pages[finviz.quote_url(TICKER)] = ladder.FetchSkipped("finviz.com 오늘 요청 예산(250건)을 다 써서 보내지 않음")
    _ask()
    assert finviz.wait_idle(5)
    answer = _ask()
    assert (answer.status, answer.message) == ("skipped", "오늘 Finviz 검색 예산 소진")
    assert net.blocked == [], "예산 소진은 끊김이 아님"
    clock = {"now": time.monotonic()}
    monkeypatch.setattr(finviz, "_clock", lambda: clock["now"])
    assert _ask().status == "skipped" and len(net.urls) == 1, "5분 안에는 다시 받지 않음"
    clock["now"] += finviz.FAILURE_TTL + 1
    assert _ask().status == "pending", "5분 뒤에는 다시 줄에 넣음"


def test_거부는_error와_끊김_알림(net):
    closed = state.Closed("finviz.com", "HTTP 403(계층 browser)", None, True)
    net.pages[finviz.quote_url(TICKER)] = ladder.FetchRejected(closed)
    _ask()
    assert finviz.wait_idle(5)
    answer = _ask()
    assert (answer.status, answer.message) == ("error", closed.message())
    assert net.blocked == [("search_watch", "blocked", closed.message(), 120)]


def test_형식이_바뀌면_error(net):
    net.pages[finviz.quote_url(TICKER)] = "<html><body><p>Synthetic maintenance page</p></body></html>"
    _ask()
    assert finviz.wait_idle(5)
    answer = _ask()
    assert (answer.status, answer.message) == ("error", "형식이 바뀜") and net.blocked == []


def test_사유_글과_로그에_티커·경로가_남지_않는다(net, caplog):
    net.pages[finviz.quote_url(TICKER)] = ladder.FetchFailed(f"finviz.com 읽기 실패 https://finviz.com/quote.ashx?t={TICKER} (HTTP 502)")
    with caplog.at_level(logging.DEBUG):
        _ask()
        assert finviz.wait_idle(5)
        answer = _ask()
    assert answer.status == "error" and answer.message.startswith("finviz.com")
    assert TICKER not in answer.message and "quote.ashx" not in answer.message
    assert TICKER not in caplog.text and "quote.ashx" not in caplog.text


# ==============================================================================
# 관심 대상 수집의 동기 입구(계약 §8-7)
# ==============================================================================
def test_관심_대상_수집은_캐시가_있으면_요청도_예산도_쓰지_않는다(net):
    _ask()
    assert finviz.wait_idle(5)
    answer = finviz.for_watch(TICKER, take=lambda: pytest.fail("캐시가 있으면 예산을 쓰지 않음"))
    assert (answer.sent, answer.took, len(answer.items)) == (False, False, 1) and len(net.urls) == 1


def test_관심_대상_수집은_예산을_쓰고_같은_캐시를_채운다(net):
    taken = []
    answer = finviz.for_watch(TICKER, take=lambda: taken.append(1) or True)
    assert (answer.sent, answer.took, answer.failure, answer.note) == (True, True, None, None)
    assert taken == [1] and [item["source"] for item in answer.items] == ["finviz"]
    assert net.budget_calls == [], "관심 대상 수집의 예산은 부르는 쪽(take — 용도 watch)"
    assert _ask().status == "cached", "즉석 검색이 같은 캐시를 씀"
    refused = finviz.for_watch("SYNB", take=lambda: False)
    assert (refused.sent, refused.took) == (False, False) and len(net.urls) == 1


def test_관심_대상_수집의_거부는_그_대상의_Finviz만_건너뛴다(net):
    closed = state.Closed("finviz.com", "HTTP 403(계층 impersonate)", None, False)
    net.pages[finviz.quote_url(TICKER)] = ladder.FetchRejected(closed, sent=False)
    answer = finviz.for_watch(TICKER, take=lambda: True)
    assert answer.failure is None and answer.note and "finviz.com" in answer.note
    assert (answer.took, answer.sent) == (True, False), "닫혀 있어 보내지 않은 요청은 세지 않음"
    assert net.blocked == [], "호스트 닫힘은 계층이 기록 — 관심 대상 수집의 판정은 다른 출처로"
    net.pages[finviz.quote_url("SYNB")] = ladder.FetchFailed("finviz.com HTTP 502")
    failed = finviz.for_watch("SYNB", take=lambda: True)
    assert failed.failure == "finviz.com HTTP 502" and failed.sent is True


def test_관심_대상_수집도_같은_잠금을_거친다(net, monkeypatch):
    net.gate = threading.Event()
    _ask("SYNA")
    assert net.started.wait(5)
    monkeypatch.setattr(finviz, "WATCH_LOCK_WAIT", 0.1)
    waited = finviz.for_watch("SYNB", take=lambda: pytest.fail("잠금을 얻지 못하면 예산을 쓰지 않음"))
    assert waited.sent is False and waited.note and "다음 깨기" in waited.note
    results = []
    worker = threading.Thread(target=lambda: results.append(finviz.for_watch("SYNC", take=lambda: True)))
    monkeypatch.setattr(finviz, "WATCH_LOCK_WAIT", 5.0)
    worker.start()
    time.sleep(0.1)
    net.gate.set()
    worker.join(5)
    assert finviz.wait_idle(5)
    assert results and results[0].sent is True
    assert net.max_active == 1 and net.urls[-1] == finviz.quote_url("SYNC")


def test_관심_대상_수집이_받는_동안_즉석_검색은_예산_없이_받는_중(net):
    """관심 대상 수집이 같은 티커를 받는 중이면 즉석 검색은 줄에 넣지 않고(예산·사용자 셈 없음) 받는 중 — 다 받으면 같은 캐시를 씀."""
    net.gate = threading.Event()
    results = []
    worker = threading.Thread(target=lambda: results.append(finviz.for_watch(TICKER, take=lambda: True)))
    worker.start()
    assert net.started.wait(5)
    answer = _ask()
    assert (answer.status, answer.queued) == ("pending", False)
    assert net.budget_calls == [], "즉석 검색 예산을 쓰지 않음"
    net.gate.set()
    worker.join(5)
    assert results and results[0].sent is True
    done = _ask()
    assert done.status in ("ok", "cached") and len(net.urls) == 1


def test_즉석_검색_작업은_잠금을_놓기_전에_결과를_적는다(net, monkeypatch):
    """작업자가 잠금을 놓은 틈(로그 쓰기 등)에 같은 티커의 관심 대상 수집이 캐시가 빈 것을 보고 다시 받지 않게 — 결과·줄 지우기를 잠금 안에서."""
    net.pages[finviz.quote_url(TICKER)] = ladder.FetchFailed("finviz.com HTTP 502")
    net.gate = threading.Event()
    real_info = finviz.logger.info

    def slow_info(*args, **kwargs):
        time.sleep(0.5)                       # 잠금을 놓은 뒤라면 이 틈에 관심 대상 수집이 잠금을 얻음
        return real_info(*args, **kwargs)

    monkeypatch.setattr(finviz.logger, "info", slow_info)
    _ask()
    assert net.started.wait(5)
    results = []
    worker = threading.Thread(target=lambda: results.append(finviz.for_watch(TICKER, take=lambda: True)))
    worker.start()
    time.sleep(0.1)
    net.gate.set()
    worker.join(5)
    assert finviz.wait_idle(5)
    assert len(net.urls) == 1, "실패 결과를 잠금 안에서 적어 관심 대상 수집이 5분 실패 캐시를 씀"
    assert results and results[0].sent is False


def test_오늘_날짜는_KST_날짜로_예산을_센다(net, monkeypatch):
    monkeypatch.setattr(finviz.rules, "kst_today", lambda now=None: date(2026, 11, 15))
    _ask()
    assert finviz.wait_idle(5)
    assert net.budget_calls[0][2] == date(2026, 11, 15)


# ==============================================================================
# 단계 5 검토 지적(고친 뒤 고정)
# ==============================================================================
def _host_row(**fields) -> dict:
    """표 fetch_hosts의 finviz.com 줄(합성)."""
    row = {"host": finviz.HOST, "last_good_tier": None, "fail_level": 0, "blocked_until": None, "blocked_reason": None,
           "given_up": False, "profile": None, "profile_lib": None}
    row.update(fields)
    return row


def test_잠금을_기다리는_동안_다른_길이_남긴_실패도_5분_다시_쓴다(net, monkeypatch):
    """관심 대상 수집이 같은 티커를 받다 실패해 5분 캐시를 남겼으면 기다리던 즉석 검색 작업은 다시 보내지 않고, 그 기한도 늘리지 않음."""
    lock = finviz._send_lock
    lock.acquire()
    try:
        assert _ask().queued is True
        time.sleep(0.05)
        with finviz._lock:
            finviz._store_outcome(TICKER, finviz._Outcome("error", message="finviz.com HTTP 502"), unread=False)
            expires = finviz._results[TICKER].expires
    finally:
        lock.release()
    assert finviz.wait_idle(5)
    assert net.urls == [], "실패 캐시 안에서는 다시 받지 않음"
    assert finviz._results[TICKER].expires == expires, "작업이 남은 캐시의 기한을 늘리지 않음"
    answer = _ask()
    assert (answer.status, answer.message) == ("error", "finviz.com HTTP 502")


def test_캐시를_본_뒤_작업이_끝났으면_예산을_쓰지_않고_그_결과를_쓴다(net, monkeypatch):
    def finished_meanwhile() -> bool:
        with finviz._lock:      # 첫 캐시 확인과 줄 확인 사이에 작업자가 결과를 남기고 줄에서 빠짐
            finviz._store_outcome(TICKER, finviz._Outcome("ok", items=("synthetic",)), unread=True)
        return True

    monkeypatch.setattr(finviz, "_server_enabled", finished_meanwhile)
    answer = _ask()
    assert (answer.status, answer.queued, answer.items) == ("ok", False, ("synthetic",))
    assert net.budget_calls == [] and net.urls == [] and finviz.wait_idle(1)


def test_닫혀_있어_보내지_않은_거부는_끊김_알림을_다시_걸지_않는다(net):
    """닫힌 동안의 즉석 검색마다 blocked를 다시 쓰면 관심 대상 수집의 ok와 번갈아 알림이 쌓임 — 새로 거부당했을 때만."""
    closed = state.Closed("finviz.com", "HTTP 403(계층 impersonate)", None, True)
    net.pages[finviz.quote_url(TICKER)] = ladder.FetchRejected(closed, sent=False)
    _ask()
    assert finviz.wait_idle(5)
    answer = _ask()
    assert (answer.status, answer.message) == ("error", closed.message())
    assert net.blocked == []


def test_닫힌_호스트는_줄에_넣지_않고_예산도_쓰지_않는다(net):
    net.host_row = _host_row(given_up=True, fail_level=5, blocked_reason="HTTP 403(계층 browser)")
    closed = state.Closed("finviz.com", "HTTP 403(계층 browser)", None, True)
    answer = _ask()
    assert (answer.status, answer.message, answer.queued) == ("error", closed.message(), False)
    assert finviz.wait_idle(1)
    assert net.budget_calls == [] and net.urls == [] and net.blocked == []
    watched = finviz.for_watch(TICKER, take=lambda: pytest.fail("닫힌 호스트에는 관심 대상 수집도 예산을 쓰지 않음"))
    assert (watched.took, watched.sent, watched.failure) == (False, False, None) and watched.note == closed.message()


def test_브라우저_계층으로_지나가게_돼도_즉석_검색은_보낸다(net):
    """컨테이너 호출은 계층이 과정 안에서 한 줄로 세움(browser_client._flight) — 통과 계층이 browser여도 즉석 검색을 끄지 않음."""
    net.host_row = _host_row(last_good_tier=policy.TIER_BROWSER)
    answer = _ask()
    assert (answer.status, answer.queued) == ("pending", True)
    assert finviz.wait_idle(5) and len(net.urls) == 1


def test_깨진_링크가_있어도_그_줄만_건너뛴다():
    markup = _page([_news_row("Nov-13-26 11:24PM", "Synthetic good story", "https://www.example.com/g1", "Synthetic Wire"),
                    _news_row("10:00PM", "Synthetic broken link", "http://[bad/x", "Synthetic Wire"),
                    _news_row("09:00PM", "Synthetic later story", "https://www.example.com/g2", "Synthetic Wire")])
    items = finviz.parse_news_table(markup, now=NOW)
    assert [(item["title"], item["publishedAt"]) for item in items] == [
        ("Synthetic good story", "2026-11-14T04:24:00+00:00"), ("Synthetic later story", "2026-11-14T02:00:00+00:00")]


def test_줄_만들기의_예상_밖_예외도_형식이_바뀜이고_관심_대상_수집을_멈추지_않는다(net, monkeypatch):
    def broken(markup, *, now):
        raise ValueError("Invalid IPv6 URL")

    monkeypatch.setattr(finviz, "parse_news_table", broken)
    answer = finviz.for_watch(TICKER, take=lambda: True)
    assert (answer.failure, answer.sent, answer.items) == (finviz.SHAPE_CHANGED, True, ())
    _ask("SYNB")
    assert finviz.wait_idle(5)
    assert _ask("SYNB").message == finviz.SHAPE_CHANGED


def test_종목_화면이_아닌_곳으로_옮겨진_답은_쓰지_않는다(net):
    """같은 호스트 안의 리다이렉트(로그인·유료·검색 화면)를 따라간 답은 뉴스 표가 있어도 쓰지 않음 — quote.ashx 한 쪽만."""
    net.final_urls[finviz.quote_url(TICKER)] = "https://finviz.com/login.ashx?next=synthetic"
    _ask()
    assert finviz.wait_idle(5)
    answer = _ask()
    assert (answer.status, answer.message, answer.items) == ("error", finviz.MOVED, ())
    assert TICKER not in answer.message and "login" not in answer.message
    net.final_urls[finviz.quote_url("SYNB")] = "https://finviz.com/elite.ashx"
    moved = finviz.for_watch("SYNB", take=lambda: True)
    assert (moved.failure, moved.items) == (finviz.MOVED, ())
    assert finviz.for_watch("SYNC", take=lambda: True).items, "quote.ashx에 머문 답은 그대로 씀"


def test_관심_대상_수집은_계층_올림에_필요한_시간이_남을_때만_Finviz를_묻는다(net):
    gap = policy.POLICIES[finviz.HOST].gap
    need = browser_client.MIN_TIME_LEFT + 2 * (gap.long_high + 1) + sum(impersonate.DEFAULT_TIMEOUT)
    assert finviz.WATCH_MIN_TIME_LEFT >= need, "지연 두 번 + 계층 1 + 계층 2의 최소 남은 시간"
    assert finviz.JOB_DEADLINE >= finviz.WATCH_MIN_TIME_LEFT, "즉석 검색 작업도 한 번 올라갈 시간이 있음"
    guard = http.TaskGuard(deadline=time.monotonic() + need - 30)
    answer = http.run_guarded(guard, lambda: finviz.for_watch(TICKER, take=lambda: pytest.fail("시간이 모자라면 예산을 쓰지 않음")))
    assert answer.sent is False and "다음 깨기" in answer.note and net.urls == []
