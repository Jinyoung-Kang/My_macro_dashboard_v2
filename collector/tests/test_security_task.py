"""
tests/test_security_task.py
보안 공지 태스크 kisa_security_notices(ADR 0046 결정 3·4) — 받기 순서·간격·메우기·저장·출처 상태.

고정하는 규칙
  1. flex 속도군에 due와 함께 등록. 일정이 없으면 받지 않고 다음 KST 구간으로 정하고, 때가 아니면 외부 호출 0회(일정 그대로).
  2. 언제: KST 하루를 [00,06)·[06,12)·[12,18)·[18,24)로 나누고, 한 실행은 결과(성공·실패·거부)와 무관하게 다음 시각을 지금 구간의 다음 구간 안
     [시작+30분, 시작+5시간30분]으로만 정함 → 구간마다 최대 한 번 = 하루 최대 네 번(시계를 돌려 가며 셈).
  3. 한 실행 = 목록 1쪽 → (메우는 중이면) 메우기 쪽 → 처음 본 글 넣기 → 상세 최대 12건. 요청과 요청 사이는 3~6초(쉼을 가로채 셈 — 실제로 쉬지 않음).
     실행 시간 예산은 420초.
  4. 처음 90일을 메우는 동안은 같은 실행에서 1쪽과 아직 못 본 번호의 다음 쪽을 둘 다 읽음(그 사이 새 글로 쪽이 밀려도 건너뛰지 않음).
     90일보다 오래된 글은 넣되 상세를 받지 않음.
  5. 상세는 4열 표의 행·제품명·'※' 문장·본문을 저장(다시 받으면 행을 통째로 바꿈). 받지 못한 상세는 3번까지 다시.
  6. 출처 상태: 성공 ok, 목록·상세를 받지 못함 failed, 모양이 다름 format, 거부 blocked(목록 1쪽 거부는 예외를 그대로 올림).
     '오래 못 받음'은 30시간(1800분). 고정 공지는 1쪽이 정함.

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


class _Edge:
    """난수 자리 — uniform(a, b)가 늘 a(``low``) 또는 b를 돌려줌(구간 경계 시험)."""

    def __init__(self, low: bool):
        self.low = low

    def uniform(self, a: float, b: float) -> float:
        return a if self.low else b


def _kst(day: int, hour: int, minute: int = 0, second: int = 0) -> datetime:
    return datetime(2026, 11, day, hour, minute, second, tzinfo=task.kst.KST)


def _window(moment: datetime) -> tuple[date, int]:
    """KST 날짜와 구간 번호(0~3)."""
    local = moment.astimezone(task.kst.KST)
    return local.date(), local.hour // 6


def _in_next_window(after: datetime, when: datetime) -> bool:
    """``when``이 ``after``가 속한 KST 구간의 다음 구간 안 [시작+30분, 시작+5시간30분]에 있는가."""
    local = after.astimezone(task.kst.KST)
    start = local.replace(hour=local.hour - local.hour % 6, minute=0, second=0, microsecond=0) + timedelta(hours=6)
    return start + timedelta(minutes=30) <= when.astimezone(task.kst.KST) <= start + timedelta(minutes=330)


def _run_until_settled(board: FakeBoard, limit: int = 80) -> list[str]:
    """다음 시각마다 깨워 메우기·받을 상세가 끝날 때까지 돌립니다 → 실행 기록들."""
    details = []
    for _ in range(limit):
        board.clock["now"] = max(board.clock["now"], _next_due())
        details.append(task.task_kisa_security_notices())
        if "메우는 중" not in details[-1] and "받을 상세 남음" not in details[-1]:
            return details
    raise AssertionError("메우기가 끝나지 않음")


def _notices(store) -> dict[int, dict]:
    with store.connection() as conn:
        return {r["ntt_id"]: r for r in conn.execute("SELECT * FROM security_notices").fetchall()}


# ==============================================================================
# 1. 등록·일정
# ==============================================================================
def test_flex에_due와_함께_등록되고_시간_예산은_flex_상한_안이다():
    registered = tasks.TASKS_BY_NAME["kisa_security_notices"]
    assert registered.speed == flex.SPEED and registered.run is task.task_kisa_security_notices and registered.due is task.due
    # 예산을 넘기 직전에 시작한 마지막 요청 하나(쉼 + 공용 세션의 두 번 다시 보내기까지)가 flex 상한 안에 끝나야 합니다.
    assert task.TIME_LIMIT_SECONDS + task.GAP_SECONDS[1] + 3 * task.REQUEST_TIMEOUT <= tasks.TASK_DEADLINE_SECONDS["flex"]
    assert (task.DETAIL_LIMIT, task.GAP_SECONDS, task.BACKFILL_DAYS, task.TIME_LIMIT_SECONDS, task.STALE_AFTER_MINUTES,
            task.WINDOW_HOURS, task.WINDOW_MARGIN_MINUTES) == (12, (3.0, 6.0), 90, 420.0, 1800, 6, 30)
    assert not hasattr(task, "PAGE1_ITEM"), "1쪽 다시 읽기 일정 항목은 더 쓰지 않음(1쪽은 실행마다 읽음)"


@pytest.mark.parametrize("now, start", [
    (_kst(21, 5, 59, 59), _kst(21, 6)),
    (_kst(21, 6), _kst(21, 12)),
    (_kst(21, 11, 59), _kst(21, 12)),
    (_kst(21, 12), _kst(21, 18)),
    (_kst(21, 17, 59), _kst(21, 18)),
    (_kst(21, 18), _kst(22, 0)),
    (_kst(21, 23, 59), _kst(22, 0)),
    (_kst(30, 23, 59), datetime(2026, 12, 1, 0, 0, tzinfo=task.kst.KST)),    # 달을 넘김
    (_kst(22, 0), _kst(22, 6)),
])
def test_다음_시각은_지금_구간의_다음_구간_안_30분부터_5시간30분까지(monkeypatch, now, start):
    for low, offset in ((True, timedelta(minutes=30)), (False, timedelta(hours=5, minutes=30))):
        monkeypatch.setattr(task, "_rng", _Edge(low))
        slot = task.next_slot(now.astimezone(timezone.utc))
        assert slot.tzinfo is not None and slot == start + offset, (now, low)


def test_일정이_없으면_받지_않고_다음_구간으로_정하고_때가_아니면_일정을_바꾸지_않는다(store, board):
    assert task.due() is True
    with pytest.raises(EmptyResult, match="외부 호출 0회"):
        task.task_kisa_security_notices()
    first = _next_due()
    assert _in_next_window(NOW, first), "처음도 다음 구간(KST 18:30~23:30)"
    assert task.due() is False
    board.clock["now"] = first - timedelta(minutes=1)
    with pytest.raises(EmptyResult, match="아직 때가 아님"):
        task.task_kisa_security_notices()
    assert _next_due() == first, "때가 아니면 일정 그대로"
    assert board.calls == [] and board.sleeps == []


def test_시계를_돌려_가며_구간마다_한_번_하루_최대_네_번이고_실패해도_다음_구간으로만(store, board):
    """5분마다 틱(due → 실행)을 사흘 돌립니다. 첫날은 목록 1쪽이 늘 503, 둘째 날은 거부, 셋째 날은 받음 — 어느 쪽이든 구간마다 한 번."""
    runs: list[datetime] = []
    end = NOW + timedelta(days=3)
    while board.clock["now"] < end:
        moment = board.clock["now"]
        day = (moment - NOW) // timedelta(days=1)
        board.override.pop(kisa_notices.list_url(1), None)
        if day == 0:
            board.override[kisa_notices.list_url(1)] = (503, "")
        elif day == 1:
            board.override[kisa_notices.list_url(1)] = http.SourceRejected("www.boho.or.kr", "HTTP 403")
        if task.due():
            before = len(board.calls)
            try:
                task.task_kisa_security_notices()
            except (EmptyResult, http.SourceRejected):
                pass
            if len(board.calls) > before:
                runs.append(moment)
                assert _in_next_window(moment, _next_due()), moment
            http.reset_guards()
        board.clock["now"] = moment + timedelta(minutes=5)

    windows = [_window(moment) for moment in runs]
    assert len(windows) == len(set(windows)), "구간마다 최대 한 번"
    per_day: dict[date, int] = {}
    for day, _ in windows:
        per_day[day] = per_day.get(day, 0) + 1
    assert max(per_day.values()) == 4 and len(runs) >= 11, per_day
    offsets = [(m.astimezone(task.kst.KST).hour % 6) * 60 + m.astimezone(task.kst.KST).minute for m in runs]
    assert all(30 <= offset <= 335 for offset in offsets), "구간의 처음·끝 30분은 비움(5분 틱만큼 늦을 수 있음)"


# ==============================================================================
# 2. 한 실행
# ==============================================================================
def test_첫_실행은_목록_1쪽과_메우기_쪽에_최근_상세_12건이고_요청_사이를_3_6초_쉰다(store, board):
    _due_now(board)

    detail = task.task_kisa_security_notices()

    assert board.pages() == [1, 2], "메우는 중이면 1쪽과 메우기 쪽을 한 실행에서"
    assert board.details() == [BASE_ID + n for n in range(500, 488, -1)], "최근 글부터 12건"
    assert board.calls[0].endswith("pageIndex=1"), "목록이 먼저"
    assert len(board.sleeps) == 13 and all(3.0 <= s <= 6.0 for s in board.sleeps), "요청 사이마다 한 번(목록→목록→상세 포함)"
    assert detail.startswith("목록 1쪽 12건(처음 본 글 12) · 목록 2쪽 12건(처음 본 글 10) · 상세 12건") and "90일 메우는 중" in detail
    assert _in_next_window(NOW, _next_due())
    state = store.source_state(task.TASK_NAME)
    assert state["status"] == "ok" and state["stale_after_minutes"] == 1800

    rows = _notices(store)
    assert rows[BASE_ID - 1]["pinned"] is True and rows[BASE_ID - 1]["list_no"] is None
    assert rows[BASE_ID - 2]["detail_status"] == "skipped", "90일보다 오래된 고정 공지는 상세를 받지 않음"
    assert rows[BASE_ID + 481]["detail_status"] == "pending"
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


def test_시간_예산을_넘기면_새_요청을_시작하지_않는다(store, board):
    _due_now(board)
    board.advance_per_request = 100.0

    detail = task.task_kisa_security_notices()

    assert board.pages() == [1, 2] and len(board.details()) == 3 and "상세 3건" in detail, "100·200·300·400초에 시작, 500초에 멈춤"


def test_메우기가_끝났으면_목록은_1쪽만(store, board):
    board.posts = [post for post in board.posts if post.number > 495]       # 다섯 건 — 번호 1~5로, 1쪽에 다 들어감
    for post in board.posts:
        post.number -= 495
    _due_now(board)

    detail = task.task_kisa_security_notices()

    assert board.pages() == [1] and "메우는 중" not in detail
    assert len(board.details()) == 6, "번호 글 다섯 + 90일 안의 고정 공지 하나"


# ==============================================================================
# 3. 90일 메우기
# ==============================================================================
def test_90일을_메우면_실행마다_1쪽과_다음_쪽을_읽고_끝나면_1쪽만(store, board):
    _due_now(board)

    runs = _run_until_settled(board)

    pages = board.pages()
    backfill = [p for p in pages if p != 1]
    assert backfill == list(range(2, backfill[-1] + 1)) and backfill[-1] >= 25, "번호로 센 다음 쪽 — 건너뛰지 않음"
    assert pages.count(1) == len(runs), "1쪽은 실행마다"
    rows = _notices(store)
    numbered = {n for n, r in rows.items() if r["list_no"] is not None}
    assert numbered == {BASE_ID + n for n in range(500 - 10 * backfill[-1] + 1, 501)}, "마지막 메우기 쪽까지 빈 곳 없이"
    # 90일의 기준은 실행 때의 오늘(KST)이라 메우는 며칠(구간마다 한 번) 사이에 밀립니다 — 끝난 때의 기준을 넘을 때까지 메우고,
    # 그 기준 안은 모두 받고, 처음 기준 밖은 받지 않음.
    final_cutoff = board.clock["now"].astimezone(task.kst.KST).date() - timedelta(days=90)
    assert final_cutoff > CUTOFF
    assert min(rows[n]["posted_on"] for n in numbered) < final_cutoff, "끝난 때의 90일 경계를 넘을 때까지 메움"
    assert all(r["detail_status"] == "ok" for r in rows.values() if r["posted_on"] >= final_cutoff)
    assert all(r["detail_status"] == "skipped" for r in rows.values() if r["posted_on"] < CUTOFF)
    fetched = sorted(n for n, r in rows.items() if r["detail_status"] == "ok")
    assert sorted(board.details()) == fetched, "상세는 90일 안의 글만 한 번씩"
    assert all(3.0 <= s <= 6.0 for s in board.sleeps) and len(board.sleeps) == len(board.details()) + len(pages) - len(runs)
    assert _in_next_window(board.clock["now"], _next_due())

    board.calls.clear()
    board.clock["now"] = _next_due()
    assert task.task_kisa_security_notices().startswith("목록 1쪽 12건(처음 본 글 0) · 상세 0건")
    assert board.pages() == [1] and board.details() == []


def test_메우는_중_새_글이_올라와도_번호를_건너뛰지_않는다(store, board):
    _due_now(board)
    task.task_kisa_security_notices()                       # 1쪽(491~500)·2쪽(481~490)
    for number in range(501, 506):                          # 새 글 다섯 — 쪽이 다섯 칸 밀림
        board.add(number, TODAY)
    board.clock["now"] = _next_due()
    task.task_kisa_security_notices()                       # 1쪽(496~505)을 넣은 뒤 셈 → 3쪽 = 지금의 476~485
    assert board.pages() == [1, 2, 1, 3]
    numbers = sorted(r["list_no"] for r in _notices(store).values() if r["list_no"] is not None)
    assert numbers == list(range(476, 506)), "번호가 빈 곳 없이 이어짐"


def test_메우기_쪽을_받지_못해도_1쪽과_상세는_이어_간다(store, board):
    _due_now(board)
    board.override[kisa_notices.list_url(2)] = (502, "")

    detail = task.task_kisa_security_notices()

    assert board.pages() == [1, 2] and len(board.details()) == 11, "1쪽의 번호 글 열 + 90일 안의 고정 공지 하나"
    assert "목록 2쪽 받지 못함 — HTTP 502" in detail and "상세 11건" in detail
    assert store.source_state(task.TASK_NAME)["status"] == "failed"


def test_고정_공지는_1쪽이_정한다(store, board):
    _due_now(board)
    task.task_kisa_security_notices()
    board.pinned = board.pinned[:1]
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
    assert _in_next_window(NOW, _next_due()), "실패해도 다음 구간으로만"


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
    assert _in_next_window(NOW, _next_due()), "거부돼도 다음 구간으로만"


def test_상세_하나를_받지_못하면_나머지는_받고_3번까지_다시_받는다(store, board):
    _due_now(board)
    bad = kisa_notices.detail_url(BASE_ID + 499)
    board.override[bad] = (404, "")

    detail = task.task_kisa_security_notices()

    assert "상세 11건" in detail and "상세 실패 1건(받지 못함 1·모양이 다름 0)" in detail
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

