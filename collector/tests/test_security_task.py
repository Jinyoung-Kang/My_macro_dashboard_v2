"""
tests/test_security_task.py
보안 공지 태스크 kisa_security_notices(ADR 0046 결정 3·4) — 받기 순서·간격·메우기·저장·출처 상태.

고정하는 규칙
  1. flex 속도군에 due와 함께 등록. 일정이 없으면 받지 않고 2~25분 뒤로 정하고, 때가 아니면 외부 호출 0회.
  2. 한 실행 = 목록 한 쪽 → 처음 본 글 넣기 → 상세 최대 8건. 요청과 요청 사이는 3~6초(쉼을 가로채 셈 — 실제로 쉬지 않음).
  3. 처음 90일을 메우는 동안은 아직 못 본 번호의 다음 쪽(그 사이 새 글로 쪽이 밀려도 겹칠 뿐 건너뛰지 않음), 1쪽은 평소 간격마다 한 번.
     메우는 동안(목록이 덜 찼거나 받을 상세가 남음) 다음 실행은 20~40분, 끝나면 3~6시간. 90일보다 오래된 글은 넣되 상세를 받지 않음.
  4. 상세는 4열 표의 행·제품명·'※' 문장·본문을 저장(다시 받으면 행을 통째로 바꿈). 받지 못한 상세는 3번까지 다시.
  5. 출처 상태: 성공 ok, 목록·상세를 받지 못함 failed, 모양이 다름 format, 거부 blocked(목록 거부는 예외를 그대로 올림). 고정 공지는 1쪽이 정함.

외부 네트워크를 쓰지 않습니다 — 가짜 게시판이 합성 목록·상세를 돌려줍니다(requests 전송도 막아 둠). 제품 이름·버전·CVE는 모두 가짜입니다.
태스크 시험은 PostgreSQL이 필요합니다(store 픽스처, macrodash_test).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest
import requests

from app import http, tasks
from app.services import kisa_notices
from app.tasks import flex
from app.tasks import security as task
from app.tasks.base import EmptyResult

NOW = datetime(2026, 11, 21, 3, 0, tzinfo=timezone.utc)      # KST 11-21 12:00
TODAY = date(2026, 11, 21)
CUTOFF = TODAY - timedelta(days=90)                          # 2026-08-23
BASE_ID = 800_000


@dataclass
class Post:
    number: int | None
    ntt_id: int
    posted_on: date
    title: str


def _detail_html(post: Post, *, product: str = "ExampleDB") -> str:
    return f"""<html><body><section id="View" class="bbs"><div class="board">
      <header><div class="b_title"><h2>{post.title}</h2><span>{post.posted_on.isoformat()}</span></div></header>
      <div class="content"><div class="content_html"><div class="s-prose">
        <p>□ 개요 <br> <span> </span>o 합성 공지 {post.ntt_id}</p>
        <table class="s-table"><thead><tr><th>취약점</th><th>제품명</th><th>영향받는 버전</th><th>해결 버전</th></tr></thead>
        <tbody><tr><td>CVE-2099-{post.ntt_id % 10000:04d}</td><td>{product}</td><td>1.0 이상 1.4 미만</td><td>1.4 이상</td></tr>
               <tr><td>CVE-2099-{post.ntt_id % 10000:04d}</td><td>{product} Tools</td><td>2.1</td><td>2.2</td></tr></tbody></table>
        <p>※ 합성 조건 문장 <br> <span> </span>※ 하단의 참고 사이트를 확인하여 업데이트 수행 [1]</p>
      </div></div></div></div></section></body></html>"""


class FakeBoard:
    """번호 1..top의 글(하루 세 건씩, 가장 큰 번호가 오늘)과 고정 공지 둘. URL → 합성 목록·상세, ``override``는 URL → 예외·(상태, 본문)."""

    def __init__(self, top: int = 500):
        self.posts: list[Post] = []
        self.pinned = [Post(None, BASE_ID - 1, TODAY - timedelta(days=5), "합성 고정 공지 하나"),
                       Post(None, BASE_ID - 2, TODAY - timedelta(days=200), "합성 고정 공지 둘")]
        for number in range(1, top + 1):
            self.add(number, TODAY - timedelta(days=(top - number) // 3))
        self.override: dict = {}
        self.calls: list[str] = []
        self.sleeps: list[float] = []
        self.clock = {"now": NOW, "mono": 0.0}
        self.advance_per_request = 0.0

    def add(self, number: int, posted_on: date) -> Post:
        post = Post(number, BASE_ID + number, posted_on, f"합성 제품 {number} 보안 업데이트 권고")
        self.posts.append(post)
        return post

    def numbered(self) -> list[Post]:
        return sorted(self.posts, key=lambda p: -p.number)

    def list_html(self, page: int) -> str:
        rows = []
        for post in self.pinned:
            rows.append(("공지", post))
        for post in self.numbered()[(page - 1) * 10: page * 10]:
            rows.append((str(post.number), post))
        body = "".join(
            f'<tr><td class="num">{num}</td><td class="sbj tal"><a href="/kr/bbs/view.do?bbsId=B0000133&amp;nttId={p.ntt_id}">'
            f'{p.title}</a></td><td class="count">1</td><td class="attach"></td><td class="date">{p.posted_on.isoformat()}</td></tr>'
            for num, p in rows) or '<tr><td colspan="5">게시물이 없습니다.</td></tr>'
        return (f"<html><body><table><thead><tr><th>번호</th><th>제목</th><th>조회수</th><th>첨부</th><th>게시일</th></tr></thead>"
                f"<tbody>{body}</tbody></table></body></html>")

    def post(self, ntt_id: int) -> Post:
        return next(p for p in self.posts + self.pinned if p.ntt_id == ntt_id)

    def session(self):
        board = self

        class _Response:
            def __init__(self, status: int, body: str):
                self.status_code = status
                self.content = body.encode("utf-8")

        class _Session:
            def get(self, url, timeout=None):
                board.calls.append(url)
                board.clock["mono"] += board.advance_per_request
                outcome = board.override.get(url)
                if isinstance(outcome, BaseException):
                    raise outcome
                if outcome is not None:
                    return _Response(*outcome)
                query = parse_qs(urlsplit(url).query)
                if "/list.do" in url:
                    return _Response(200, board.list_html(int(query["pageIndex"][0])))
                return _Response(200, _detail_html(board.post(int(query["nttId"][0]))))

        return _Session()

    def pages(self) -> list[int]:
        return [int(parse_qs(urlsplit(url).query)["pageIndex"][0]) for url in self.calls if "/list.do" in url]

    def details(self) -> list[int]:
        return [int(parse_qs(urlsplit(url).query)["nttId"][0]) for url in self.calls if "/view.do" in url]


@pytest.fixture()
def board(monkeypatch):
    fake = FakeBoard()
    monkeypatch.setattr(task, "get_session", lambda: fake.session())
    monkeypatch.setattr(task, "_now", lambda: fake.clock["now"])
    monkeypatch.setattr(task, "_clock", lambda: fake.clock["mono"])
    monkeypatch.setattr(task, "_sleep", lambda seconds: fake.sleeps.append(seconds))
    monkeypatch.setattr(flex, "_utcnow", lambda: fake.clock["now"])

    def no_network(*args, **kwargs):
        raise AssertionError("테스트가 실제 네트워크로 나가려 했습니다")

    monkeypatch.setattr(requests.Session, "send", no_network)
    return fake


def _due_now(board: FakeBoard) -> None:
    flex.set_due(task.TASK_NAME, task.SCHEDULE_ITEM, board.clock["now"] - timedelta(seconds=1))


def _next_due() -> datetime:
    return flex.due_map(task.TASK_NAME)[task.SCHEDULE_ITEM]


def _run_until_settled(board: FakeBoard, limit: int = 80) -> list[str]:
    """다음 시각마다 깨워 메우기가 끝날 때까지(다음 간격이 3시간 이상) 돌립니다 → 실행 기록들."""
    details = []
    for _ in range(limit):
        board.clock["now"] = max(board.clock["now"], _next_due())
        details.append(task.task_kisa_security_notices())
        if _next_due() - board.clock["now"] >= timedelta(minutes=task.NORMAL_MINUTES[0]):
            return details
    raise AssertionError("메우기가 끝나지 않음")


def _notices(store) -> dict[int, dict]:
    with store.connection() as conn:
        return {r["ntt_id"]: r for r in conn.execute("SELECT * FROM security_notices").fetchall()}


# ==============================================================================
# 1. 등록·일정
# ==============================================================================
def test_flex에_due와_함께_등록되고_시간_상한은_flex_상한보다_짧다():
    registered = tasks.TASKS_BY_NAME["kisa_security_notices"]
    assert registered.speed == flex.SPEED and registered.run is task.task_kisa_security_notices and registered.due is task.due
    assert task.TIME_LIMIT_SECONDS + task.DETAIL_LIMIT * (task.GAP_SECONDS[1] + task.REQUEST_TIMEOUT) <= tasks.TASK_DEADLINE_SECONDS["flex"]
    assert (task.DETAIL_LIMIT, task.GAP_SECONDS, task.NORMAL_MINUTES, task.BACKFILL_MINUTES, task.BACKFILL_DAYS) == \
        (8, (3.0, 6.0), (180.0, 360.0), (20.0, 40.0), 90)


def test_일정이_없으면_받지_않고_2_25분_뒤로_정하고_때가_아니면_부르지_않는다(store, board):
    assert task.due() is True
    with pytest.raises(EmptyResult, match="외부 호출 0회"):
        task.task_kisa_security_notices()
    assert timedelta(minutes=2) <= _next_due() - NOW <= timedelta(minutes=25)
    assert task.due() is False
    with pytest.raises(EmptyResult, match="아직 때가 아님"):
        task.task_kisa_security_notices()
    assert board.calls == [] and board.sleeps == []


# ==============================================================================
# 2. 한 실행
# ==============================================================================
def test_첫_실행은_목록_1쪽과_최근_상세_8건이고_요청_사이를_3_6초_쉰다(store, board):
    _due_now(board)

    detail = task.task_kisa_security_notices()

    assert board.pages() == [1]
    assert board.details() == [BASE_ID + n for n in range(500, 492, -1)], "최근 글부터 8건"
    assert board.calls[0].endswith("pageIndex=1"), "목록이 먼저"
    assert len(board.sleeps) == 8 and all(3.0 <= s <= 6.0 for s in board.sleeps), "요청 사이마다 한 번(목록→상세 포함)"
    assert detail.startswith("목록 1쪽 12건(처음 본 글 12) · 상세 8건") and "90일 메우는 중" in detail
    assert timedelta(minutes=20) <= _next_due() - NOW <= timedelta(minutes=40)
    state = store.source_state(task.TASK_NAME)
    assert state["status"] == "ok" and state["stale_after_minutes"] == 360 * 3

    rows = _notices(store)
    assert rows[BASE_ID - 1]["pinned"] is True and rows[BASE_ID - 1]["list_no"] is None
    assert rows[BASE_ID - 2]["detail_status"] == "skipped", "90일보다 오래된 고정 공지는 상세를 받지 않음"
    assert rows[BASE_ID + 491]["detail_status"] == "pending"
    saved = store.security_notice(BASE_ID + 500)
    assert saved["detail_status"] == "ok" and saved["layout"] == "product_table" and saved["detail_attempts"] == 1
    assert saved["products"] == ["ExampleDB", "ExampleDB Tools"]
    assert saved["notes"] == ["※ 합성 조건 문장", "※ 하단의 참고 사이트를 확인하여 업데이트 수행 [1]"]
    assert saved["rows"] == [
        {"cve": "CVE-2099-0500", "product": "ExampleDB", "affected": "1.0 이상 1.4 미만", "fixed": "1.4 이상"},
        {"cve": "CVE-2099-0500", "product": "ExampleDB Tools", "affected": "2.1", "fixed": "2.2"},
    ]
    assert "합성 공지 800500" in saved["body_text"] and "1.4 미만" not in saved["body_text"]
    assert saved["url"] == kisa_notices.detail_url(BASE_ID + 500)


def test_시간_상한을_넘기면_상세를_더_시작하지_않는다(store, board):
    _due_now(board)
    board.advance_per_request = 100.0

    detail = task.task_kisa_security_notices()

    assert len(board.details()) == 3 and "상세 3건" in detail


# ==============================================================================
# 3. 90일 메우기
# ==============================================================================
def test_90일을_메우면_다음_쪽으로_내려가고_끝나면_3_6시간_간격(store, board):
    _due_now(board)

    runs = _run_until_settled(board)

    pages = board.pages()
    assert pages[0] == 1 and [p for p in pages if p != 1] == list(range(2, 29)), "번호로 센 다음 쪽 — 건너뛰지 않음(사이사이 1쪽 다시 읽기)"
    assert pages.count(1) >= 2, "메우는 동안에도 1쪽을 평소 간격마다 다시 읽음"
    rows = _notices(store)
    numbered = {n for n, r in rows.items() if r["list_no"] is not None}
    assert {BASE_ID + n for n in range(221, 501)} == numbered, "28쪽(221~230)까지 — 경계 쪽의 오래된 글도 넣음"
    # 90일의 기준은 실행 때의 오늘(KST)이라 메우는 하루 사이에 하루 밀립니다 — 끝난 때의 기준 안은 모두 받고, 처음 기준 밖은 받지 않음.
    final_cutoff = board.clock["now"].astimezone(task.kst.KST).date() - timedelta(days=90)
    assert final_cutoff > CUTOFF
    assert all(r["detail_status"] == "ok" for r in rows.values() if r["posted_on"] >= final_cutoff)
    assert all(r["detail_status"] == "skipped" for r in rows.values() if r["posted_on"] < CUTOFF)
    fetched = sorted(n for n, r in rows.items() if r["detail_status"] == "ok")
    assert sorted(board.details()) == fetched, "상세는 90일 안의 글만 한 번씩"
    assert "메우는 중" not in runs[-1] and "받을 상세 남음" not in runs[-1]
    assert timedelta(hours=3) <= _next_due() - board.clock["now"] <= timedelta(hours=6)
    assert all(3.0 <= s <= 6.0 for s in board.sleeps) and len(board.sleeps) == len(board.details())

    board.calls.clear()
    board.clock["now"] = _next_due()
    assert task.task_kisa_security_notices().startswith("목록 1쪽 12건(처음 본 글 0) · 상세 0건")
    assert board.pages() == [1] and board.details() == []


def test_메우는_중_새_글이_올라와도_번호를_건너뛰지_않고_1쪽은_평소_간격마다_다시_읽는다(store, board):
    _due_now(board)
    task.task_kisa_security_notices()                       # 1쪽(491~500)
    board.clock["now"] = _next_due()
    task.task_kisa_security_notices()                       # 2쪽(481~490)
    for number in range(501, 506):                          # 새 글 다섯 — 쪽이 다섯 칸 밀림
        board.add(number, TODAY)
    board.clock["now"] = _next_due()
    task.task_kisa_security_notices()                       # 셈은 옛 최댓값(500) 기준 3쪽 = 지금의 476~485 — 겹칠 뿐
    assert board.pages() == [1, 2, 3]
    assert BASE_ID + 480 in _notices(store) and BASE_ID + 501 not in _notices(store)

    flex.set_due(task.TASK_NAME, task.PAGE1_ITEM, board.clock["now"] - timedelta(seconds=1))   # 1쪽 다시 읽을 때
    board.clock["now"] = _next_due()
    task.task_kisa_security_notices()
    assert board.pages()[-1] == 1 and BASE_ID + 505 in _notices(store)
    board.clock["now"] = _next_due()
    task.task_kisa_security_notices()
    assert board.pages()[-1] == 4, "다시 메우기 쪽으로 — 새 최댓값(505) 기준"
    numbers = sorted(r["list_no"] for r in _notices(store).values() if r["list_no"] is not None)
    assert numbers == list(range(numbers[0], 506)), "번호가 빈 곳 없이 이어짐"


def test_고정_공지는_1쪽이_정한다(store, board):
    _due_now(board)
    task.task_kisa_security_notices()
    board.pinned = board.pinned[:1]
    flex.set_due(task.TASK_NAME, task.PAGE1_ITEM, board.clock["now"])
    board.clock["now"] = _next_due()
    task.task_kisa_security_notices()

    rows = _notices(store)
    assert rows[BASE_ID - 1]["pinned"] is True and rows[BASE_ID - 2]["pinned"] is False


# ==============================================================================
# 4. 실패
# ==============================================================================
def test_목록을_받지_못하면_EmptyResult이고_출처_상태는_failed(store, board):
    _due_now(board)
    board.override[kisa_notices.list_url(1)] = (503, "")

    with pytest.raises(EmptyResult, match="목록 1쪽 받지 못함 — HTTP 503"):
        task.task_kisa_security_notices()

    assert board.details() == [] and _notices(store) == {}
    assert store.source_state(task.TASK_NAME)["status"] == "failed"
    assert _next_due() > NOW


def test_목록_연결_오류도_failed(store, board):
    _due_now(board)
    board.override[kisa_notices.list_url(1)] = requests.exceptions.ConnectionError("연결 끊김")

    with pytest.raises(EmptyResult, match="받지 못함"):
        task.task_kisa_security_notices()
    assert store.source_state(task.TASK_NAME)["status"] == "failed"


def test_목록_모양이_다르면_format(store, board):
    _due_now(board)
    board.override[kisa_notices.list_url(1)] = (200, "<html><body><p>점검 중</p></body></html>")

    with pytest.raises(EmptyResult, match="모양이 다름"):
        task.task_kisa_security_notices()
    state = store.source_state(task.TASK_NAME)
    assert state["status"] == "format" and "목록 표" in state["reason"]


def test_목록_1쪽이_비면_format(store, board):
    _due_now(board)
    board.posts, board.pinned = [], []

    with pytest.raises(EmptyResult, match="1쪽에 글이 없음"):
        task.task_kisa_security_notices()
    assert store.source_state(task.TASK_NAME)["status"] == "format"


def test_목록을_거부하면_예외를_그대로_올리고_blocked(store, board):
    _due_now(board)
    board.override[kisa_notices.list_url(1)] = http.SourceRejected("www.boho.or.kr", "HTTP 403")

    with pytest.raises(http.SourceRejected):
        task.task_kisa_security_notices()
    assert store.source_state(task.TASK_NAME)["status"] == "blocked"
    assert board.details() == []


def test_상세_하나를_받지_못하면_나머지는_받고_3번까지_다시_받는다(store, board):
    _due_now(board)
    bad = kisa_notices.detail_url(BASE_ID + 499)
    board.override[bad] = (404, "")

    detail = task.task_kisa_security_notices()

    assert "상세 7건" in detail and "상세 실패 1건(받지 못함 1·모양이 다름 0)" in detail
    row = store.security_notice(BASE_ID + 499)
    assert row["detail_status"] == "failed" and row["detail_attempts"] == 1 and row["detail_error"] == "받지 못함 — HTTP 404"
    assert store.source_state(task.TASK_NAME)["status"] == "failed"

    for attempt in (2, 3):
        board.clock["now"] = _next_due()
        task.task_kisa_security_notices()
        assert store.security_notice(BASE_ID + 499)["detail_attempts"] == attempt
    board.calls.clear()
    board.clock["now"] = _next_due()
    task.task_kisa_security_notices()
    assert bad not in board.calls, "세 번 실패하면 더 받지 않음"


def test_상세_모양이_다르면_format이고_받아_둔_공지는_그대로(store, board):
    _due_now(board)
    board.override[kisa_notices.detail_url(BASE_ID + 500)] = (200, _detail_html(board.post(BASE_ID + 500)).replace(
        "<td>1.0 이상 1.4 미만</td>", ""))

    task.task_kisa_security_notices()

    row = store.security_notice(BASE_ID + 500)
    assert row["detail_status"] == "failed" and row["rows"] == [] and "칸 수가 3" in row["detail_error"]
    state = store.source_state(task.TASK_NAME)
    assert state["status"] == "format" and "상세 모양이 다름" in state["reason"]


def test_상세를_거부하면_그_실행의_상세를_멈추고_시도를_세지_않는다(store, board):
    _due_now(board)
    board.override[kisa_notices.detail_url(BASE_ID + 498)] = http.SourceRejected("www.boho.or.kr", "HTTP 429")

    detail = task.task_kisa_security_notices()

    assert board.details() == [BASE_ID + 500, BASE_ID + 499, BASE_ID + 498]
    assert "상세 2건" in detail and "출처 거부로 상세 멈춤" in detail
    assert store.security_notice(BASE_ID + 498)["detail_attempts"] == 0
    assert store.source_state(task.TASK_NAME)["status"] == "blocked"


def test_상세를_다시_받으면_표_행을_통째로_바꾼다(store, board):
    _due_now(board)
    task.task_kisa_security_notices()
    post = board.post(BASE_ID + 500)

    store.save_security_detail(BASE_ID + 500, kisa_notices.parse_detail(_detail_html(post, product="OtherDB")))

    saved = store.security_notice(BASE_ID + 500)
    assert [r["product"] for r in saved["rows"]] == ["OtherDB", "OtherDB Tools"] and saved["detail_attempts"] == 2
    with pytest.raises(ValueError, match="목록에 없는 공지"):
        store.save_security_detail(1, kisa_notices.parse_detail(_detail_html(post)))
