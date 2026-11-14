"""
tests/test_search_watch.py
정보 검색의 관심 대상 정기 수집(ADR 0041 결정 9, 계약 §6-2·§6-3 — tasks/search_watch, store의 V37 함수, search_store.watch_items).

고정하는 규칙
  1. 표(V37): 관심 대상은 사용자·대표 키마다 하나, 사용자를 지우면 함께 지워짐. 제외 매체는 (종류, 값 소문자)마다 하나. 예산 표의 용도는 watch·search.
  2. 서버에서만: POLITE_FETCH_ENABLED가 꺼지면 외부 호출 0건(표도 읽지 않음).
  3. 깰 때 때가 된 대상 6곳까지(처음 등록된 대상 먼저), 대상마다 다음 시각 3~8시간, 여러 사용자가 같은 대상을 등록해도 한 번.
     일정 줄 이름은 대표 키의 해시(회원이 쓴 주제 글이 운영자 메커니즘 화면에 드러나지 않게).
  4. 저장본 대조(외부 0건) + 구글(한·영)·Bing(한·영, 0건이면 다음 구문으로 한 번 더) — 호스트 하루 예산(news.google.com 600·www.bing.com 600,
     용도 watch)을 넘으면 보내지 않음(Bing의 두 번째 구문도 한 건).
     예산만 모자란 깨기는 끊김이 아님(보낸 요청이 다 성공했거나, 하나도 못 보냈어도 직전 판정이 정상이면 '정상'). 요청 사이 2~5초.
     검색어에 티커·짧은 별칭 없음, 등록 때의 이름 둘(한·영)은 짧아도 씀(즉석 검색과 같은 검색어).
  5. 넣기 전 규칙: 2년·중국어 제목·'.cn'·처음 값·사용자가 더한 제외 매체, 같은 글은 한 번(이미 있는 글은 처음 받은 시각 그대로), 경유 주소 줄은 같은
     제목(전체)의 글이 이미 있으면 넣지 않음. 경유 주소 줄의 글 id는 경유 주소의 기사 경로 — 제목 앞 24자가 같은 다른 기사도 남음.
  6. 정리: 등록이 풀린 대상의 글은 7일 유예 뒤, 2년 지난 글(둘 다 KST 하루 한 번), 제외 매체의 글(제외 목록이 바뀌었을 때).
  7. 정보 검색이 읽는 모은 글: 운영자 전용 출처(속보·수집 글)에서 온 줄은 운영자에게만. 뉴스 탭에는 수집 글에서 온 줄을 넣지 않고(글 탭의 것),
     모은 글의 건수는 '관심 대상 수집' 상태 줄에 셈(상태 줄 건수의 합 = 줄 수).

외부 네트워크를 쓰지 않습니다 — 구글·Bing 함수를 합성 결과로 바꿔 끼웁니다. PostgreSQL이 필요합니다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import psycopg
import pytest
import requests

from app import catalog, tasks
from app.services import search_rules as rules
from app.services import search_sources as sources
from app.services import search_store
from app.tasks import flex, polite
from app.tasks import search_watch as task
from app.tasks.base import EmptyResult

NOW = datetime.now(timezone.utc).replace(microsecond=0)
_real_bing, _real_google = sources.bing, sources.google
# 보이는 이름은 한국어(짧아도 이름이면 검색어에 씀), 별칭에 영문 이름·티커·짧은 별칭(검색어에 넣지 않음).
ENTITY = {"key": "us:SCHP", "kind": "company", "name": "합성칩",
          "aliases": ["SynthChip", "SynthChip Corporation", "합성칩", "SCHP", "SC"], "ids": {"ticker": "SCHP", "market": "us"}}


def _iso(delta: timedelta) -> str:
    return rules.utc_iso(NOW - delta)


def _news(title, url, *, source, publisher="Example Wire", domain=None, ago=timedelta(days=1), lang="en"):
    return sources.feed_item(title=title, url=url, publisher=publisher, domain=domain or rules.domain_of(url),
                             published=_iso(ago) if ago is not None else None, source=source, lang=lang)


class External:
    """구글·Bing 자리 — 부른 (출처, 판, 검색어)를 적고 판마다 정한 결과를 줍니다."""

    def __init__(self, monkeypatch):
        self.calls: list[tuple] = []
        self.google_results = {
            "ko": sources.Fetched(items=[_news("합성칩, 새 공장 착공", "https://news.google.com/rss/articles/K1", source="google_ko",
                                               lang="ko", ago=timedelta(hours=5))]),
            "en": sources.Fetched(items=[
                _news("SynthChip opens new fab", "https://news.google.com/rss/articles/E1", source="google_en"),
                _news("合成芯片发布新一代加速器", "https://news.google.com/rss/articles/E2", source="google_en"),
                _news("SynthChip story from a .cn site", "https://news.google.com/rss/articles/E3", source="google_en",
                      domain="finance.example.cn"),
                _news("SynthChip ten years ago", "https://news.google.com/rss/articles/E4", source="google_en",
                      ago=timedelta(days=900)),
            ]),
        }
        self.bing_results = {
            "ko": sources.Fetched(items=[]),
            "en": sources.Fetched(items=[
                _news("SynthChip opens new fab", "https://www.example.org/fab", source="bing"),
                _news("SynthChip outlook from excluded outlet", "https://www.excluded-wire.com/a", source="bing",
                      publisher="Excluded Wire"),
            ]),
        }
        monkeypatch.setattr(sources, "google", self.google)
        monkeypatch.setattr(sources, "bing", self.bing)

    def google(self, terms, lang, *, after=None, session=None):
        self.calls.append(("google", lang, tuple(terms), after))
        return self.google_results[lang]

    def bing(self, terms_by_lang, *, session=None, before_retry=None):
        (lang, terms), = terms_by_lang.items()
        self.calls.append(("bing", lang, tuple(terms), None))
        return self.bing_results[lang]


@pytest.fixture()
def world(store, monkeypatch):
    """서버(POLITE 켜짐)·지금 시각·외부 자리·요청 사이 쉼 기록. 태스크 일정은 지금 실행할 때로."""
    sleeps: list[float] = []
    monkeypatch.setattr(task, "_now", lambda: NOW)
    monkeypatch.setattr(task, "_sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr(flex, "_utcnow", lambda: NOW)

    def no_network(*args, **kwargs):
        raise AssertionError("테스트가 실제 네트워크로 나가려 했습니다")

    monkeypatch.setattr(requests.Session, "send", no_network)
    search_store.reset_excludes()
    task.reset_maintenance()
    external = External(monkeypatch)
    external.sleeps = sleeps
    _due_now(store)
    yield external
    search_store.reset_excludes()
    task.reset_maintenance()


def _due_now(store) -> None:
    store.set_fetch_due_at(task.TASK_NAME, datetime.now(timezone.utc) - timedelta(minutes=1))


def _user(store, email: str) -> int:
    with store.connection() as conn:
        return conn.execute("INSERT INTO users (email, password_hash, role) VALUES (%s, 'x', 'MEMBER') RETURNING id",
                            (email,)).fetchone()["id"]


def _watch(store, user_id: int, target: dict, *, created: datetime | None = None) -> None:
    from psycopg.types.json import Jsonb

    with store.connection() as conn:
        conn.execute("INSERT INTO search_watches (user_id, entity_key, kind, name, aliases, ids, created_at) "
                     "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                     (user_id, target["key"], target["kind"], target["name"], Jsonb(target["aliases"]), Jsonb(target["ids"]),
                      created or NOW))


def _exclude(store, kind: str, value: str) -> None:
    with store.connection() as conn:
        conn.execute("INSERT INTO search_media_excludes (kind, value) VALUES (%s, %s)", (kind, value))


def _items(store, key: str | None = None) -> dict:
    with store.connection() as conn:
        rows = conn.execute("SELECT * FROM search_watch_items" + (" WHERE entity_key = %s" if key else ""),
                            (key,) if key else ()).fetchall()
    return {row["title"]: row for row in rows}


def _bundle(store, entity: str, title: str, *, published: str | None, fetched: str) -> None:
    url = f"https://www.example.edu/{entity}"
    store.insert_new_observations(catalog.OBS_SEARCH_FEED_HEADLINE, [
        (fetched[:10], entity, {"title": title, "summary": None, "url": url, "publisher": "Synthetic Press",
                                "publisherDomain": "example.edu", "feed": "fed_press_all", "publishedAt": published,
                                "fetchedAt": fetched, "timeBasis": "published" if published else "fetched", "lang": "en"}),
    ])


# ==============================================================================
# 1. 표(V37)
# ==============================================================================
def test_V37_표의_유일성과_사용자_삭제(store):
    user = _user(store, "a@example.org")
    _watch(store, user, ENTITY)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _watch(store, user, ENTITY)
    _exclude(store, "domain", "example-wire.com")
    with pytest.raises(psycopg.errors.UniqueViolation):
        _exclude(store, "domain", "Example-Wire.COM")
    with pytest.raises(psycopg.errors.CheckViolation):
        _exclude(store, "outlet", "x")
    with store.connection() as conn:
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("INSERT INTO fetch_budgets (host, purpose, budget_day) VALUES ('h', 'other', CURRENT_DATE)")
    with store.connection() as conn:
        row = conn.execute("SELECT last_seen_at, created_at FROM search_watches").fetchone()
        assert row["last_seen_at"] is not None
        conn.execute("DELETE FROM users WHERE id = %s", (user,))
        assert conn.execute("SELECT count(*) AS n FROM search_watches").fetchone()["n"] == 0
        indexes = {row["indexname"] for row in conn.execute(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'search_watch_items' AND schemaname = current_schema()").fetchall()}
        assert "search_watch_items_time" in indexes, "2년 정리(작성 시각 범위)가 쓰는 색인"


def test_대상은_대표_키마다_하나이고_별칭은_합친다(store):
    first, second = _user(store, "a@example.org"), _user(store, "b@example.org")
    _watch(store, first, ENTITY, created=NOW - timedelta(days=2))
    _watch(store, second, dict(ENTITY, name="SynthChip Inc", aliases=["SynthChip Inc", "synthchip"]), created=NOW)
    _watch(store, second, {"key": "topic:합성 반도체", "kind": "topic", "name": "합성 반도체", "aliases": ["합성 반도체"], "ids": {}})
    targets = store.search_watch_targets()
    assert [target["key"] for target in targets] == ["topic:합성 반도체", "us:SCHP"]
    merged = targets[1]
    assert merged["name"] == "SynthChip Inc" and merged["watchers"] == 2, "이름은 가장 최근 등록의 것"
    assert merged["aliases"] == ["SynthChip Inc", "synthchip", "SynthChip Corporation", "합성칩", "SCHP", "SC"]


def test_검색_예산은_용도마다_KST_날짜로_세고_정기_예산과_따로(store):
    day = NOW.date()
    assert [store.take_search_budget("news.google.com", "watch", day, 2) for _ in range(3)] == [True, True, False]
    assert store.take_search_budget("news.google.com", "search", day, 2) is True, "용도가 다르면 따로"
    assert store.take_search_budget("news.google.com", "watch", day + timedelta(days=1), 2) is True, "날짜가 바뀌면 1부터"
    assert store.take_search_budget("news.google.com", "watch", day, 0) is False
    assert store.fetch_host("news.google.com") is None, "정기 polite 예산(fetch_hosts)에 쓰지 않음"


# ==============================================================================
# 2. 서버에서만
# ==============================================================================
def test_차단_통과_수집이_꺼지면_외부_호출도_표_읽기도_없다(store, monkeypatch):
    monkeypatch.delenv(polite.ENV_ENABLED, raising=False)
    calls = []
    monkeypatch.setattr(sources, "google", lambda *a, **k: calls.append("google"))
    monkeypatch.setattr(sources, "bing", lambda *a, **k: calls.append("bing"))
    monkeypatch.setattr(requests.Session, "send", lambda *a, **k: calls.append("send"))
    monkeypatch.setattr(store, "search_watch_targets", lambda: calls.append("targets") or [])
    monkeypatch.setattr(store, "search_media_excludes", lambda: calls.append("excludes") or [])
    with pytest.raises(EmptyResult, match="운영 서버에서만"):
        tasks.TASKS_BY_NAME["search_watch"].run()
    assert calls == []
    assert store.fetch_due_at(task.TASK_NAME) is None and store.source_state(task.TASK_NAME) is None


def test_태스크는_polite로_등록되고_간격은_20_40분():
    registered = tasks.TASKS_BY_NAME["search_watch"]
    assert registered.speed == polite.SPEED and registered.run is task.task_search_watch and registered.due is None
    assert (task.CADENCE.low_minutes, task.CADENCE.high_minutes) == (20.0, 40.0)
    assert (task.ENTITIES_PER_WAKE, task.ENTITY_MINUTES, task.UNWATCHED_GRACE_DAYS) == (6, (180.0, 480.0), 7)
    assert task.DAILY_BUDGETS == {"news.google.com": 600, "www.bing.com": 600} and task.PURPOSE == "watch"


# ==============================================================================
# 3·4·5. 한 번 깨기
# ==============================================================================
def test_대상의_글을_저장본과_구글·Bing에서_모아_규칙을_거쳐_넣는다(store, world):
    _watch(store, _user(store, "a@example.org"), ENTITY)
    _exclude(store, "name", "excluded wire")
    _bundle(store, "f1", "Central bank cites SynthChip supply", published=_iso(timedelta(days=2)), fetched=_iso(timedelta(days=2)))
    _bundle(store, "f2", "SynthChip Corporation expands", published=None, fetched=_iso(timedelta(days=3)))
    _bundle(store, "f3", "Unrelated macro wrap", published=_iso(timedelta(days=1)), fetched=_iso(timedelta(days=1)))

    detail = task.task_search_watch()

    assert detail.startswith("관심 대상 1/1곳 처리 · 새 글 4건 · 바깥 요청 4건")
    assert sorted((call[0], call[1]) for call in world.calls) == [("bing", "en"), ("bing", "ko"), ("google", "en"), ("google", "ko")]
    for _, lang, terms, _after in world.calls:
        assert "SCHP" not in terms and "SC" not in terms, "티커·짧은 별칭은 자유 검색어에 넣지 않음"
        assert all(rules.has_hangul(term) == (lang == "ko") for term in terms)
    assert world.sleeps and all(2.0 <= value <= 5.0 for value in world.sleeps) and len(world.sleeps) == 3
    items = _items(store, "us:SCHP")
    assert set(items) == {"Central bank cites SynthChip supply", "SynthChip Corporation expands", "합성칩, 새 공장 착공",
                          "SynthChip opens new fab"}
    assert items["SynthChip opens new fab"]["source"] == "bing", "같은 글은 Bing(원문 주소)이 구글(경유 주소)보다 먼저 — 하나만"
    assert items["SynthChip opens new fab"]["item_id"] == rules.item_key("https://www.example.org/fab", "x")
    undated = items["SynthChip Corporation expands"]
    assert undated["published_at"] is None and undated["source"] == "feeds"
    assert abs(undated["first_seen_at"] - (NOW - timedelta(days=3))) < timedelta(seconds=2), "시각 없는 저장본 글은 그 글을 처음 받은 시각"
    dated = items["Central bank cites SynthChip supply"]
    assert dated["published_at"] is not None and abs(dated["first_seen_at"] - NOW) < timedelta(seconds=2)
    assert items["합성칩, 새 공장 착공"]["source"] == "google_ko" and items["합성칩, 새 공장 착공"]["lang"] == "ko"
    titles = set(_items(store))
    assert not {"合成芯片发布新一代加速器", "SynthChip story from a .cn site", "SynthChip ten years ago",
                "SynthChip outlook from excluded outlet", "Unrelated macro wrap"} & titles
    schedule = flex.due_map(task.TASK_NAME)
    assert timedelta(minutes=180) <= schedule[task.schedule_item("us:SCHP")] - NOW <= timedelta(minutes=480)
    assert store.source_state(task.TASK_NAME)["status"] == "ok"
    with store.connection() as conn:
        used = {row["host"]: row["budget_used"] for row in conn.execute("SELECT host, budget_used FROM fetch_budgets").fetchall()}
    assert used == {"news.google.com": 2, "www.bing.com": 2}

    # 다시 깨도 때가 아닌 대상은 묻지 않고, 이미 있는 글은 그대로입니다.
    world.calls.clear()
    _due_now(store)
    detail = task.task_search_watch()
    assert world.calls == [] and detail.startswith("때가 된 관심 대상 없음(등록 1곳")


def test_이미_있는_글은_처음_받은_시각_그대로이고_경유_주소_줄은_같은_제목이면_넣지_않는다(store, world):
    _watch(store, _user(store, "a@example.org"), ENTITY)
    task.task_search_watch()
    first = {title: row["first_seen_at"] for title, row in _items(store).items()}

    world.google_results["en"] = sources.Fetched(items=[
        _news("SynthChip opens new fab", "https://news.google.com/rss/articles/E9", source="google_en")])
    flex.set_due(task.TASK_NAME, task.schedule_item("us:SCHP"), NOW - timedelta(seconds=1))
    _due_now(store)
    task.task_search_watch()
    again = _items(store)
    assert {title: row["first_seen_at"] for title, row in again.items()} == first
    assert [row["source"] for row in again.values() if row["title"] == "SynthChip opens new fab"] == ["bing"]


def test_구글_경유_글은_제목_앞_24자가_같아도_다른_기사면_둘_다_남는다(store, world):
    """경유 주소 줄의 저장 id는 경유 주소의 기사 경로 — 같은 실행 안에서도, 다음 실행에서도 앞 24자가 같은 다른 기사를 막지 않습니다."""
    _watch(store, _user(store, "a@example.org"), ENTITY)
    rise, fall = "SynthChip Corporation shares rise on AI demand", "SynthChip Corporation shares fall after earnings miss"
    assert rules.title_key(rise) == rules.title_key(fall), "시험의 전제: 앞 24자가 같음"
    world.google_results["en"] = sources.Fetched(items=[
        _news(rise, "https://news.google.com/rss/articles/R1?oc=5", source="google_en"),
        _news(fall, "https://news.google.com/rss/articles/R2?oc=5", source="google_en")])
    world.bing_results["en"] = sources.Fetched(items=[])
    task.task_search_watch()
    stored = _items(store, "us:SCHP")
    assert {rise, fall} <= set(stored), "같은 실행 안에서 둘 다"
    assert stored[rise]["item_id"] != stored[fall]["item_id"]

    later = "SynthChip Corporation shares slip as rivals gain"
    assert rules.title_key(later) == rules.title_key(rise)
    world.google_results["en"] = sources.Fetched(items=[
        _news(rise, "https://news.google.com/rss/articles/R1?oc=7", source="google_en"),
        _news(later, "https://news.google.com/rss/articles/R3", source="google_en")])
    flex.set_due(task.TASK_NAME, task.schedule_item("us:SCHP"), NOW - timedelta(seconds=1))
    _due_now(store)
    task.task_search_watch()
    again = _items(store, "us:SCHP")
    assert later in again, "다음 실행에서 앞 24자가 같은 새 기사도 들어감"
    assert sum(1 for row in again.values() if row["title"] == rise) == 1, "같은 기사(경로가 같음)는 인자가 달라도 한 번"


def test_일정_줄_이름에_대상_키가_드러나지_않는다(store, world):
    topic = {"key": "topic:합성 비밀 주제", "kind": "topic", "name": "합성 비밀 주제", "aliases": ["합성 비밀 주제"], "ids": {}}
    _watch(store, _user(store, "a@example.org"), topic)
    task.task_search_watch()
    names = list(store.fetch_due_rows(task.SCHEDULE_PREFIX))
    assert names == [task.SCHEDULE_PREFIX + task.schedule_item(topic["key"])]
    assert all("합성" not in name and "topic" not in name for name in names)
    assert len(task.schedule_item(topic["key"])) == 16 and task.schedule_item("us:SCHP") != task.schedule_item("us:SCHQ")


def test_등록_때의_이름_둘을_되살려_즉석_검색과_같은_검색어를_쓴다(store, world):
    """대상 풀기는 별칭 맨 앞에 이름(한·영)을 두고 그 뒤 별칭은 네 글자 이상만 — 정기 수집도 짧은 영문 이름 'Kia'로 묻습니다(계약 규칙 5)."""
    usable = ["Kia Motors Corporation", "Kia Corporation", "Kia Motors", "KIA Corp.", "기아자동차", "기아 주식회사"]
    instant = {"key": "kr:000270", "kind": "company", "name": "기아", "nameKo": "기아", "nameEn": "Kia",
               "aliases": rules.dedupe_texts(["기아", "Kia"] + usable), "ids": {"stockCode": "000270", "market": "kr"}}
    target = {"key": "kr:000270", "kind": "company", "name": "기아", "aliases": instant["aliases"], "ids": instant["ids"]}
    entity = task.watch_entity(target)
    for lang in ("ko", "en"):
        assert rules.edition_terms(entity, lang) == rules.edition_terms(instant, lang)
    assert rules.match_terms(entity) == rules.match_terms(instant)

    _watch(store, _user(store, "a@example.org"), target)
    task.task_search_watch()
    english = [terms for kind, lang, terms, _ in world.calls if lang == "en"]
    assert english and all("Kia" in terms for terms in english)


def test_한_번에_6곳까지이고_처음_등록된_대상이_먼저(store, world):
    user = _user(store, "a@example.org")
    keys = [f"topic:합성 주제 {n}" for n in range(8)]
    for key in keys:
        _watch(store, user, {"key": key, "kind": "topic", "name": key[6:], "aliases": [key[6:]], "ids": {}})
    flex.set_due(task.TASK_NAME, task.schedule_item(keys[0]), NOW - timedelta(hours=1))
    flex.set_due(task.TASK_NAME, task.schedule_item(keys[1]), NOW + timedelta(hours=1))
    detail = task.task_search_watch()
    assert detail.startswith("관심 대상 6/8곳 처리") and "때가 된 대상 1곳은 다음 깨기" in detail
    schedule = {key: flex.due_map(task.TASK_NAME).get(task.schedule_item(key)) for key in keys}
    processed = {key for key in keys if schedule.get(key) and schedule[key] - NOW >= timedelta(minutes=180)}
    assert processed == set(keys[2:]), "일정 없는(처음 등록된) 대상 먼저"


def test_하루_예산이_없으면_그_호스트는_보내지_않고_저장본_대조만(store, world):
    _watch(store, _user(store, "a@example.org"), ENTITY)
    _bundle(store, "f1", "Central bank cites SynthChip supply", published=_iso(timedelta(days=2)), fetched=_iso(timedelta(days=2)))
    with store.connection() as conn:
        conn.execute("INSERT INTO fetch_budgets (host, purpose, budget_day, budget_used) VALUES ('news.google.com', 'watch', %s, 600)",
                     (rules.kst_today(NOW),))
    detail = task.task_search_watch()
    assert [call[0] for call in world.calls] == ["bing", "bing"]
    assert "하루 예산으로 보내지 않음(news.google.com 하루 예산 600건 소진)" in detail
    assert "Central bank cites SynthChip supply" in _items(store)
    assert store.source_state(task.TASK_NAME)["status"] == "ok", "보낸 요청은 모두 성공 — 예산 소진은 출처의 끊김이 아님"
    assert flex.due_map(task.TASK_NAME)[task.schedule_item("us:SCHP")] > NOW + timedelta(hours=2), "다음 시각은 잡음"


def test_Bing의_두_번째_구문도_예산에서_한_건을_쓰고_간격을_둔다(store, world, monkeypatch):
    """Bing은 판마다 구문 하나 — 0건이면 다음 구문으로 한 번 더(services/search_sources.bing). 그 한 번도 호스트 하루 예산과 요청 간격을 거칩니다."""
    _watch(store, _user(store, "a@example.org"), ENTITY)
    allowed = []

    def bing(terms_by_lang, *, session=None, before_retry=None):
        (lang, terms), = terms_by_lang.items()
        world.calls.append(("bing", lang, tuple(terms), None))
        allowed.append(before_retry())
        return sources.Fetched(items=[])

    monkeypatch.setattr(sources, "bing", bing)
    detail = task.task_search_watch()
    assert allowed == [True, True]
    assert "바깥 요청 6건" in detail and len(world.sleeps) == 5
    with store.connection() as conn:
        used = {row["host"]: row["budget_used"] for row in conn.execute("SELECT host, budget_used FROM fetch_budgets").fetchall()}
    assert used == {"news.google.com": 2, "www.bing.com": 4}


def test_Bing의_두_번째_구문은_예산이_없으면_보내지_않는다(store, world, monkeypatch):
    _watch(store, _user(store, "a@example.org"), ENTITY)
    with store.connection() as conn:
        conn.execute("INSERT INTO fetch_budgets (host, purpose, budget_day, budget_used) VALUES ('www.bing.com', 'watch', %s, %s)",
                     (rules.kst_today(NOW), task.DAILY_BUDGETS["www.bing.com"] - 1))
    allowed = []

    def bing(terms_by_lang, *, session=None, before_retry=None):
        allowed.append(before_retry())
        return sources.Fetched(items=[])

    monkeypatch.setattr(sources, "bing", bing)
    detail = task.task_search_watch()
    assert allowed == [False], "첫 판이 마지막 한 건을 쓰고, 두 번째 구문·영어 판은 보내지 않음"
    assert "www.bing.com 하루 예산 600건 소진" in detail
    assert store.source_state(task.TASK_NAME)["status"] == "ok"


def test_보낼_질의가_없는_주제는_예산도_간격도_쓰지_않는다(store, world, monkeypatch):
    """따옴표·공백뿐인 주제는 판 검색어가 있어도 Bing 구문·구글 검색식을 만들 수 없음 — 예산·요청 수·간격을 매기지 않음(판정을 '정상'으로 덮지 않게)."""
    _watch(store, _user(store, "a@example.org"), {"key": 'topic:"', "kind": "topic", "name": '"', "aliases": ['"'], "ids": {}})
    sent = []
    monkeypatch.setattr(sources, "_bing_once", lambda *a, **k: sent.append("bing") or ([], None))
    monkeypatch.setattr(sources, "_google_raw", lambda *a, **k: sent.append("google") or (None, None, "x"))
    monkeypatch.setattr(sources, "bing", _real_bing)       # 구글·Bing 자리(External)를 실제 함수로 되돌리고 보내는 곳만 셈
    monkeypatch.setattr(sources, "google", _real_google)
    detail = task.task_search_watch()
    assert sent == [] and "바깥 요청 0건" in detail and world.sleeps == []
    with store.connection() as conn:
        assert conn.execute("SELECT count(*) AS n FROM fetch_budgets").fetchone()["n"] == 0


def _spend_all_budgets(store) -> None:
    with store.connection() as conn:
        for host, limit in task.DAILY_BUDGETS.items():
            conn.execute("INSERT INTO fetch_budgets (host, purpose, budget_day, budget_used) VALUES (%s, 'watch', %s, %s)",
                         (host, rules.kst_today(NOW), limit))


def test_예산이_모두_바닥나_하나도_못_보낸_깨기도_직전이_정상이면_끊김으로_보이지_않는다(store, world):
    _watch(store, _user(store, "a@example.org"), ENTITY)
    _spend_all_budgets(store)
    store.note_source_state(task.TASK_NAME, "ok", None, stale_after_minutes=120, when=NOW - timedelta(hours=5))
    detail = task.task_search_watch()
    assert world.calls == [] and "하루 예산으로 보내지 않음" in detail
    state = store.source_state(task.TASK_NAME)
    assert state["status"] == "ok" and state["last_ok_at"] > NOW - timedelta(minutes=5), \
        "예산 소진이 2시간 넘게 이어져도 마지막 성공 시각이 고쳐져 '오래 못 받음'이 되지 않음"


def test_예산이_모두_바닥나_하나도_못_보낸_깨기는_직전_실패_판정을_지우지_않는다(store, world):
    _watch(store, _user(store, "a@example.org"), ENTITY)
    _spend_all_budgets(store)
    store.note_source_state(task.TASK_NAME, "failed", "google_en news.google.com HTTP 503", stale_after_minutes=120)
    store.note_source_state(task.TASK_NAME, "failed", "google_en news.google.com HTTP 503", stale_after_minutes=120)
    task.task_search_watch()
    state = store.source_state(task.TASK_NAME)
    assert (state["status"], state["streak"], state["last_ok_at"]) == ("failed", 2, None), "닿지 않은 출처를 '정상'으로 적지 않음"


def test_바깥_질의가_실패하면_받은_것은_넣고_받지_못함으로_남긴다(store, world):
    _watch(store, _user(store, "a@example.org"), ENTITY)
    world.google_results["en"] = sources.Fetched(error="news.google.com HTTP 503")
    detail = task.task_search_watch()
    assert "일부 받지 못함(google_en news.google.com HTTP 503)" in detail
    assert store.source_state(task.TASK_NAME)["status"] == "failed"
    assert "SynthChip opens new fab" in _items(store)


# ==============================================================================
# 6. 정리
# ==============================================================================
def _seed_item(store, key: str, title: str, *, published: datetime | None, publisher="Example Wire", domain="example.org"):
    store.insert_search_watch_items(key, [{"item_id": rules.title_key(title) or title, "kind": "news", "title": title,
                                           "url": None, "publisher": publisher, "publisher_domain": domain, "source": "bing",
                                           "lang": "en", "summary": None, "published_at": published, "first_seen_at": NOW}])


def test_등록이_풀린_대상의_글은_7일_유예_뒤에_지운다(store, world):
    _seed_item(store, "topic:풀린 대상", "Recently unwatched story", published=NOW - timedelta(days=1))
    _seed_item(store, "topic:오래 풀린 대상", "Long unwatched story", published=NOW - timedelta(days=1))
    flex.set_due(task.TASK_NAME, task.schedule_item("topic:풀린 대상"), NOW + timedelta(hours=3))
    flex.set_due(task.TASK_NAME, task.schedule_item("topic:오래 풀린 대상"), NOW + timedelta(hours=3))
    with store.connection() as conn:
        conn.execute("UPDATE fetch_schedule SET updated_at = now() - interval '8 days' WHERE task = %s",
                     (task.SCHEDULE_PREFIX + task.schedule_item("topic:오래 풀린 대상"),))
    detail = task.task_search_watch()
    assert set(_items(store)) == {"Recently unwatched story"}, "SQL의 md5와 파이썬의 해시가 같은 줄을 가리킴(한글 키)"
    assert "등록이 풀린 대상의 글 1건(일정 1줄)" in detail
    assert task.schedule_item("topic:오래 풀린 대상") not in flex.due_map(task.TASK_NAME)
    assert task.schedule_item("topic:풀린 대상") in flex.due_map(task.TASK_NAME)


def test_2년_지난_글과_제외_매체의_글은_깨날_때마다_지운다(store, world):
    _watch(store, _user(store, "a@example.org"), {"key": "topic:합성", "kind": "topic", "name": "합성", "aliases": ["합성"], "ids": {}})
    flex.set_due(task.TASK_NAME, task.schedule_item("topic:합성"), NOW + timedelta(hours=3))
    _seed_item(store, "topic:합성", "Fresh story", published=NOW - timedelta(days=1))
    _seed_item(store, "topic:합성", "Ancient story", published=NOW - timedelta(days=800))
    _seed_item(store, "topic:합성", "Story from a newly excluded outlet", published=NOW - timedelta(days=1),
               publisher="Synthetic Daily", domain="synthetic-daily.com")
    _exclude(store, "domain", "synthetic-daily.com")
    detail = task.task_search_watch()
    assert set(_items(store)) == {"Fresh story"}
    assert "2년 지난 글 1건" in detail and "제외 매체 글 1건" in detail and world.calls == []


def test_정리는_KST_하루_한_번이고_제외_매체_정리는_목록이_바뀔_때만(store, world, monkeypatch):
    calls: list[str] = []
    for name in ("purge_unwatched_search_items", "delete_search_watch_items_before", "search_watch_item_publishers"):
        original = getattr(store, name)
        monkeypatch.setattr(store, name, lambda *a, _name=name, _original=original, **k: calls.append(_name) or _original(*a, **k))
    task.task_search_watch()
    assert calls == ["purge_unwatched_search_items", "delete_search_watch_items_before", "search_watch_item_publishers"]

    calls.clear()
    _due_now(store)
    task.task_search_watch()
    assert calls == [], "같은 KST 날, 같은 제외 목록이면 표 전체를 훑지 않음"

    _exclude(store, "domain", "synthetic-daily.com")
    search_store.reset_excludes()
    _due_now(store)
    task.task_search_watch()
    assert calls == ["search_watch_item_publishers"], "제외 목록이 바뀌면 그 정리만"

    calls.clear()
    monkeypatch.setattr(task, "_now", lambda: NOW + timedelta(days=1))
    monkeypatch.setattr(flex, "_utcnow", lambda: NOW + timedelta(days=1))
    _due_now(store)
    task.task_search_watch()
    assert calls == ["purge_unwatched_search_items", "delete_search_watch_items_before"], "KST 날이 바뀌면 다시"


def test_정리가_실패해도_수집은_이어가고_다음_깨기에_다시_정리한다(store, world, monkeypatch):
    _watch(store, _user(store, "a@example.org"), ENTITY)

    original = store.delete_search_watch_items_before
    calls: list[str] = []

    def slow(*args, **kwargs):
        calls.append("slow")
        raise psycopg.errors.QueryCanceled("canceling statement due to statement timeout")

    monkeypatch.setattr(store, "delete_search_watch_items_before", slow)
    detail = task.task_search_watch()
    assert "정리 못 함(QueryCanceled)" in detail and "새 글" in detail
    assert store.source_state(task.TASK_NAME)["status"] == "ok", "정리는 출처의 판정과 따로"

    monkeypatch.setattr(store, "delete_search_watch_items_before", lambda *a, **k: calls.append("again") or original(*a, **k))
    _due_now(store)
    task.task_search_watch()
    assert calls == ["slow", "again"], "실패한 정리는 같은 날 다음 깨기에 다시"


# ==============================================================================
# 7. 정보 검색이 읽는 모은 글
# ==============================================================================
def test_모은_글은_운영자_전용_출처를_운영자에게만_보이고_경유_주소는_뒤로(store):
    rows = [
        {"item_id": "w1", "kind": "wire", "title": "SYNTHCHIP HALTED", "url": "https://www.example.com/w1", "source": "wire"},
        {"item_id": "i1", "kind": "post", "title": "On SynthChip margins", "url": "https://blog.example.org/i1", "source": "info"},
        {"item_id": "g1", "kind": "news", "title": "SynthChip relay", "url": "https://news.google.com/rss/articles/G1",
         "source": "google_en"},
        {"item_id": "b1", "kind": "news", "title": "SynthChip original", "url": "https://www.example.org/b1", "source": "bing"},
    ]
    for offset, row in enumerate(rows):
        store.insert_search_watch_items("us:SCHP", [dict(row, publisher="Example", publisher_domain="example.org", lang="en",
                                                         summary=None, published_at=NOW - timedelta(hours=offset),
                                                         first_seen_at=NOW)])
    store.insert_search_watch_items("us:OTHER", [dict(rows[3], item_id="x1", publisher=None, publisher_domain=None, lang="en",
                                                      summary=None, published_at=None, first_seen_at=NOW)])
    member = search_store.watch_items("us:SCHP", owner=False)
    assert [item["title"] for item in member.items] == ["SynthChip original", "SynthChip relay"]
    assert {item["source"] for item in member.items} == {"watch"} and member.items[0]["readerId"] is None
    owner = search_store.watch_items("us:SCHP", owner=True)
    by_title = {item["title"]: item for item in owner.items}
    assert by_title["SYNTHCHIP HALTED"]["source"] == "wire" and by_title["SYNTHCHIP HALTED"]["readerId"] == "w1"
    assert by_title["On SynthChip margins"]["source"] == "info" and by_title["SynthChip relay"]["source"] == "watch"
    assert owner.items[-1]["title"] == "SynthChip relay", "경유 주소 줄은 뒤로"
    assert by_title["SynthChip original"]["id"] == "b1" and by_title["SynthChip original"]["timeBasis"] == "published"


def test_사용자_제외_매체는_60초_캐시이고_읽지_못하면_직전_값(store, monkeypatch):
    search_store.reset_excludes()
    _exclude(store, "domain", "WWW.Example-Wire.com")
    first = search_store.user_excludes()
    assert first.domains == frozenset({"example-wire.com"})
    _exclude(store, "name", "Synthetic Daily")
    assert search_store.user_excludes() is first, "60초 안에는 다시 읽지 않음"
    search_store.reset_excludes()
    assert search_store.user_excludes().names == frozenset({"synthetic daily"})

    def broken():
        raise psycopg.OperationalError("down")

    search_store.reset_excludes()
    monkeypatch.setattr(store, "search_media_excludes", broken)
    assert search_store.user_excludes() == rules.Excludes(), "처음부터 읽지 못하면 빈 목록(처음 값 규칙은 코드에 그대로)"
    search_store.reset_excludes()


def test_뉴스_탭에는_모은_글_가운데_수집_글을_섞지_않고_건수는_관심_대상_줄에(store, monkeypatch):
    """계약 §3-4: 수집 글은 글 탭(그리고 타임라인)의 것. 모은 글은 '관심 대상 수집' 상태 줄에서 세어, 상태 줄 건수의 합이 줄 수와 같습니다."""
    from app.services import search

    monkeypatch.setattr(requests.Session, "send", lambda *a, **k: (_ for _ in ()).throw(AssertionError("네트워크")))
    search.reset_cache()
    key = "topic:Synthetic Topic"
    base = {"publisher": "Example", "publisher_domain": "example.org", "lang": "en", "summary": None, "first_seen_at": NOW}
    store.insert_search_watch_items(key, [
        dict(base, item_id="i1", kind="post", title="Synthetic Topic margins", url="https://blog.example.org/i1", source="info",
             published_at=NOW - timedelta(hours=1)),
        dict(base, item_id="w1", kind="wire", title="SYNTHETIC TOPIC HALTED", url="https://www.example.com/w1", source="wire",
             published_at=NOW - timedelta(hours=2)),
        dict(base, item_id="b1", kind="news", title="Synthetic Topic original", url="https://www.example.org/b1", source="bing",
             published_at=NOW - timedelta(hours=3)),
    ])
    try:
        news = search.feed(key, "news", owner=True, external=False)
        assert [(item["source"], item["kind"]) for item in news["items"]] == [("wire", "wire"), ("watch", "news")]
        rows = {row["source"]: row for row in news["sources"]}
        assert (rows["watch"]["status"], rows["watch"]["count"]) == ("ok", 2)
        assert sum(row["count"] for row in news["sources"]) == len(news["items"])

        timeline = search.feed(key, "timeline", owner=True, external=False)
        assert {item["title"] for item in timeline["items"]} == {"Synthetic Topic margins", "SYNTHETIC TOPIC HALTED",
                                                                 "Synthetic Topic original"}
        assert sum(row["count"] for row in timeline["sources"]) == len(timeline["items"])

        member = search.feed(key, "news", owner=False, external=False)
        assert [(item["source"], item["kind"]) for item in member["items"]] == [("watch", "news")]
        assert {row["source"]: row["count"] for row in member["sources"]}["watch"] == 1
    finally:
        search.reset_cache()


def test_타임라인에서_모은_글의_경유_주소_줄은_같은_기사의_원문_주소_줄에_밀린다(store, monkeypatch):
    from app.services import search

    search.reset_cache()
    key = "topic:Synthetic Relay"
    title = "Synthetic Relay deal closes"
    store.insert_search_watch_items(key, [{
        "item_id": "g1", "kind": "news", "title": title, "url": "https://news.google.com/rss/articles/G1",
        "publisher": "Example", "publisher_domain": "example.org", "source": "google_en", "lang": "en", "summary": None,
        "published_at": NOW - timedelta(hours=1), "first_seen_at": NOW}])
    original = sources.Fetched(items=[_news(title, "https://www.example.org/deal", source="bing", ago=timedelta(hours=1))])
    monkeypatch.setattr(sources, "bing", lambda *a, **k: original)
    monkeypatch.setattr(sources, "google", lambda *a, **k: sources.Fetched())
    try:
        out = search.feed(key, "news", owner=False, external=True)
        assert [(item["source"], item["url"]) for item in out["items"]] == [("bing", "https://www.example.org/deal")]
    finally:
        search.reset_cache()
