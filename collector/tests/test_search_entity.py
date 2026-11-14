"""
tests/test_search_entity.py
정보 검색의 대상 키·후보·대상 풀기(services/search.py · search_entities.py · search_wikidata.py) — 네트워크·DB 없이.

- 대상 키 문법(us:·kr:·cik:·wd:·topic:) — 그 밖은 거부
- Wikidata 응답 읽기: 한국어·영어 이름·별칭·설명, 사람(P31=Q5), CIK(P5531), 상장(P414)의 티커 한정자(P249), 관계(P1830·P127·P112·P108·P169·P749·P355)
- 치는 동안의 후보(suggest): 이미 가진 색인만(DART 저장본·13F 기관·운용자·종목 매핑표·메모리의 SEC 표·거장) — 바깥 호출 0건
- Enter 후보(resolve): 로컬 + Wikidata(한글이면 ko, 아니면 en), 중국어뿐인 후보·로컬과 같은 대상은 빼고, 맨 끝에 topic:<q>
- 대상 풀기(entity): 대표 키(상장사 us:/kr:, 13F 기관 cik:, 그 밖 wd:), 관계 이름은 ko·en 라벨, 13F 운용자↔기관, 외부 호출을 끄면 0건
- Wikidata·GLEIF 계열 요청은 연락처 없는 일반 이름 User-Agent(D-5)
"""
from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from app.services import search, search_entities, search_store, search_wikidata


def _snak(value):
    if isinstance(value, str) and value.startswith("Q") and value[1:].isdigit():
        return {"snaktype": "value", "datavalue": {"value": {"entity-type": "item", "id": value}, "type": "wikibase-entityid"}}
    return {"snaktype": "value", "datavalue": {"value": value, "type": "string"}}


def _claim(value, *, rank="normal", qualifiers=None):
    claim = {"mainsnak": _snak(value), "rank": rank}
    if qualifiers:
        claim["qualifiers"] = {pid: [_snak(v) for v in values] for pid, values in qualifiers.items()}
    return claim


def _entity(qid, *, ko=None, en=None, aliases_ko=(), aliases_en=(), desc_ko=None, desc_en=None, claims=None):
    labels, descriptions = {}, {}
    if ko:
        labels["ko"] = {"language": "ko", "value": ko}
    if en:
        labels["en"] = {"language": "en", "value": en}
    if desc_ko:
        descriptions["ko"] = {"language": "ko", "value": desc_ko}
    if desc_en:
        descriptions["en"] = {"language": "en", "value": desc_en}
    aliases = {}
    if aliases_ko:
        aliases["ko"] = [{"language": "ko", "value": a} for a in aliases_ko]
    if aliases_en:
        aliases["en"] = [{"language": "en", "value": a} for a in aliases_en]
    return {"id": qid, "labels": labels, "aliases": aliases, "descriptions": descriptions, "claims": claims or {}}


SYNTH_CHIP = _entity(
    "Q900001", ko="합성칩", en="SynthChip", aliases_en=("SynthChip Corporation", "SCHP", "英伟达"), aliases_ko=("합성칩 코퍼레이션",),
    desc_ko="합성 반도체 기업", desc_en="synthetic chip company",
    claims={
        "P31": [_claim("Q4830453")],
        "P5531": [_claim("0009000001")],
        "P414": [_claim("Q82059", qualifiers={"P249": ["SCHP"]})],
        "P355": [_claim("Q900010"), _claim("Q900011", rank="deprecated")],
        "P749": [_claim("Q900012", qualifiers={"P582": ["+2020-01-01T00:00:00Z"]})],
        "P169": [_claim("Q900020")],
        "P112": [_claim("Q900020")],
        # 법인 식별자(LEI) — 모양이 틀린 값은 건너뛰고 맞는 첫 값(합성 값, 검증 숫자는 맞추지 않음)
        "P1278": [_claim("NOT-A-LEI"), _claim("SYNTHCHIPLEI000000" + "42"), _claim("SYNTHCHIPLEI000001" + "07")],
    })
SYNTH_PERSON = _entity(
    "Q900020", en="Synth Founder", aliases_en=("Synthia Q. Founder",), desc_en="synthetic businessperson",
    claims={"P31": [_claim("Q5")], "P1830": [_claim("Q900030")], "P108": [_claim("Q900001")]})
LABELS = {
    "Q900010": _entity("Q900010", en="SynthChip Labs"),
    "Q900020": _entity("Q900020", ko="신스 파운더", en="Synth Founder"),
    "Q900030": _entity("Q900030", en="Founder Holdings"),
    "Q900001": _entity("Q900001", ko="합성칩", en="SynthChip"),
    "Q900040": _entity("Q900040", en="SynthChip Foundation"),
}
SYNTH_KR = _entity("Q900050", ko="합성전자", en="Synthetic Electronics", aliases_ko=("합성", "합성전자 주식회사"),
                   claims={"P31": [_claim("Q891723")], "P414": [_claim("Q495372", qualifiers={"P249": ["900001"]})]})
SYNTH_KR_OTHER = _entity("Q900051", ko="합성전자", desc_ko="다른 동명 단체", claims={"P31": [_claim("Q43229")]})
# 해외 거래소 상장(거래소 QID는 합성 — 미국·한국 거래소가 아님)
FOREIGN_EXCHANGE = "Q900098"
SYNTH_LUXE = _entity("Q900090", en="Synth Luxe", claims={
    "P31": [_claim("Q4830453")], "P414": [_claim(FOREIGN_EXCHANGE, qualifiers={"P249": ["SLX"]})]})
SYNTH_FOUNDRY = _entity("Q900091", en="Synth Foundry", claims={
    "P31": [_claim("Q4830453")], "P5531": [_claim("0009000091")],
    "P414": [_claim(FOREIGN_EXCHANGE, qualifiers={"P249": ["2330"]}), _claim("Q13677", qualifiers={"P249": ["SFY"]})]})
SYNTH_ABROAD_KR_CODE = _entity("Q900092", ko="합성해외", en="Synth Abroad", claims={
    "P31": [_claim("Q4830453")], "P414": [_claim(FOREIGN_EXCHANGE, qualifiers={"P249": ["900001"]})]})


class FakeWikidata:
    """search_wikidata.api 자리 — action·list로 합성 응답을 돌려주고 요청을 적습니다."""

    def __init__(self, *, search_results=None, cirrus=None, entities=None, fail=False):
        self.calls = []
        self.search_results = search_results or {}
        self.cirrus = cirrus or {}
        self.entities = {**LABELS, **(entities or {})}
        self.fail = fail

    def __call__(self, params):
        self.calls.append(dict(params))
        if self.fail:
            raise search_wikidata.WikidataError("www.wikidata.org HTTP 503")
        if params.get("action") == "wbsearchentities":
            return {"search": self.search_results.get((params["search"], params["language"]), [])}
        if params.get("list") == "search":
            titles = []
            for needle, found in self.cirrus.items():
                if needle in params["srsearch"]:
                    titles.extend(found)
            return {"query": {"search": [{"ns": 0, "title": t} for t in titles]}}
        if params.get("action") == "wbgetentities":
            out = {}
            for qid in params["ids"].split("|"):
                out[qid] = self.entities.get(qid, {"id": qid, "missing": ""})
            return {"entities": out}
        raise AssertionError(f"모르는 요청: {params}")


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    """바깥 호출은 모두 막고(부르면 실패), 저장본은 합성 값으로."""
    search.reset_cache()

    def refuse(*args, **kwargs):
        raise AssertionError("시험이 바깥으로 나가려 했습니다")

    monkeypatch.setattr(search_wikidata, "api", refuse)
    monkeypatch.setattr(search_entities, "_fetch_sec_table", refuse)
    monkeypatch.setattr(search_store, "dart_codes", lambda: {"900001": {"corpCode": "00900001", "name": "합성전자"},
                                                              "900002": {"corpCode": "00900002", "name": "합성전자우"}})
    monkeypatch.setattr(search_store, "guru_names", lambda: ["합성 거장"])
    yield
    search.reset_cache()


def _use_wikidata(monkeypatch, fake):
    monkeypatch.setattr(search_wikidata, "api", fake)
    return fake


def _load_sec(rows):
    search_entities.load_sec_table_for_tests({ticker: (cik, title) for ticker, cik, title in rows})


# ------------------------------------------------------------------ 대상 키

@pytest.mark.parametrize("key,expected", [
    ("us:NVDA", ("us", "NVDA")), ("us:BRK.B", ("us", "BRK.B")), ("us:BF-B", ("us", "BF-B")),
    ("kr:005930", ("kr", "005930")), ("cik:0001067983", ("cik", "0001067983")), ("wd:Q3195170", ("wd", "Q3195170")),
    ("topic:AI 반도체", ("topic", "AI 반도체")), ("topic:  rate cut ", ("topic", "rate cut")),
])
def test_대상_키_문법(key, expected):
    assert search.parse_key(key) == expected


@pytest.mark.parametrize("key", [
    "", "NVDA", "us:", "us:nvda", "us:NV DA", "us:" + "A" * 16, "kr:5930", "kr:00593A", "cik:1067983", "cik:00010679831",
    "wd:3195170", "wd:Q", "wd:Q0", "wd:q123", "topic:", "topic:   ", "topic:" + "가" * 61, "topic:a\x00b", "jp:7203",
])
def test_틀린_대상_키는_거부(key):
    with pytest.raises(ValueError):
        search.parse_key(key)


# ------------------------------------------------------------------ Wikidata 읽기

def test_Wikidata_항목_읽기():
    parsed = search_wikidata.parse_entity(SYNTH_CHIP)
    assert parsed["id"] == "Q900001" and parsed["labels"] == {"ko": "합성칩", "en": "SynthChip"}
    assert parsed["aliases"]["en"] == ["SynthChip Corporation", "SCHP", "英伟达"]
    assert parsed["descriptions"] == {"ko": "합성 반도체 기업", "en": "synthetic chip company"}
    assert parsed["human"] is False and parsed["organization"] is True
    assert parsed["cik"] == "0009000001" and parsed["tickers"] == ["SCHP"]
    assert ("subsidiary", "Q900010") in parsed["relations"]
    assert ("subsidiary", "Q900011") not in parsed["relations"], "deprecated 문장은 뺌"
    assert all(target != "Q900012" for _, target in parsed["relations"]), "끝난(P582) 관계는 뺌"
    assert ("ceo", "Q900020") in parsed["relations"] and ("founded_by", "Q900020") in parsed["relations"]
    assert search_wikidata.parse_entity(_entity("Q1", claims={"P31": [_claim("Q5")]}))["human"] is True
    assert search_wikidata.parse_entity(_entity("Q3", claims={"P31": [_claim("Q4230006")]}))["organization"] is True
    assert search_wikidata.parse_entity(_entity("Q4", claims={"P31": [_claim("Q5633421")]}))["organization"] is False
    assert search_wikidata.parse_entity({"id": "Q2", "missing": ""}) is None


def test_Wikidata_LEI는_20자_모양이_맞는_첫_값만():
    assert search_wikidata.parse_entity(SYNTH_CHIP)["lei"] == "SYNTHCHIPLEI000000" + "42"
    for bad in ("SYNTHCHIPLEI00000042X", "synthchiplei00000042", "SYNTHCHIPLEI0000004A", ""):
        parsed = search_wikidata.parse_entity(_entity("Q5", claims={"P1278": [_claim(bad)]}))
        assert parsed["lei"] is None, bad
    assert search_wikidata.parse_entity(_entity("Q6"))["lei"] is None
    deprecated = _entity("Q7", claims={"P1278": [_claim("SYNTHCHIPLEI000000" + "42", rank="deprecated")]})
    assert search_wikidata.parse_entity(deprecated)["lei"] is None


def test_연결_줄에는_detail_칸이_있다(monkeypatch):
    _load_sec([("SCHP", "0009000001", "SYNTHCHIP CORP /DE/")])
    _use_wikidata(monkeypatch, FakeWikidata(cirrus={"P5531=0009000001": ["Q900001"]}, entities={"Q900001": SYNTH_CHIP}))
    entity = search.entity("us:SCHP", external=True)["entity"]
    assert entity["links"] and all(link["detail"] is None for link in entity["links"])
    assert search_entities.empty_ids()["lei"] is None


def test_Wikidata_요청은_연락처_없는_일반_이름_UA로():
    seen = []

    class Session:
        def get(self, url, params=None, timeout=None, headers=None):
            seen.append({"url": url, "params": params, "headers": headers})
            return SimpleNamespace(status_code=200, json=lambda: {"search": []})

    search_wikidata.request({"action": "wbsearchentities", "search": "x", "language": "en"}, session=Session())
    assert seen[0]["url"] == "https://www.wikidata.org/w/api.php"
    assert seen[0]["headers"]["User-Agent"] == "LocalMacroDashboard/2.0"
    assert "@" not in seen[0]["headers"]["User-Agent"]
    assert seen[0]["params"]["format"] == "json"


def test_Wikidata_실패는_호스트와_상태만():
    class Session:
        def get(self, url, params=None, timeout=None, headers=None):
            return SimpleNamespace(status_code=503, json=lambda: {})

    with pytest.raises(search_wikidata.WikidataError) as caught:
        search_wikidata.request({"action": "wbsearchentities", "search": "비밀 검색어", "language": "ko"}, session=Session())
    assert str(caught.value) == "www.wikidata.org HTTP 503"


# ------------------------------------------------------------------ 치는 동안의 후보

def test_후보는_이미_가진_색인만_쓰고_바깥으로_나가지_않는다():
    out = search.suggest("합성전자", owner=False)
    keys = [item["key"] for item in out["items"]]
    assert keys[:2] == ["kr:900001", "kr:900002"], "완전 일치가 먼저"
    first = out["items"][0]
    assert first == {"key": "kr:900001", "kind": "company", "name": "합성전자", "sub": "900001 · 한국", "source": "dart"}
    assert out["fetchedAt"]


def test_후보_13F_기관·운용자():
    out = search.suggest("드러켄밀러", owner=False)
    assert out["items"][0] == {"key": None, "kind": "person", "name": "스탠리 드러켄밀러",
                               "sub": "13F 운용자 · 듀케인 패밀리 오피스", "source": "13f"}
    inst = search.suggest("duquesne", owner=False)["items"][0]
    assert inst["key"] == "cik:0001536411" and inst["kind"] == "institution" and inst["source"] == "13f"
    assert inst["name"] == "듀케인 패밀리 오피스" and "0001536411" in inst["sub"]


def test_후보_종목_매핑표와_메모리의_SEC_표():
    nvda = search.suggest("NVDA", owner=False)["items"][0]
    assert nvda["key"] == "us:NVDA" and nvda["source"] == "universe" and nvda["sub"] == "NVDA · 미국"
    assert search.suggest("SCHP", owner=False)["items"] == [], "SEC 표가 메모리에 없으면 받지 않음"
    _load_sec([("SCHP", "0009000001", "SYNTHCHIP CORP")])
    found = search.suggest("SCHP", owner=False)["items"][0]
    assert found["key"] == "us:SCHP" and found["source"] == "sec" and found["name"] == "SYNTHCHIP CORP"


def test_거장_후보는_운영자에게만():
    assert search.suggest("합성 거장", owner=False)["items"] == []
    guru = search.suggest("합성 거장", owner=True)["items"][0]
    assert guru == {"key": None, "kind": "person", "name": "합성 거장", "sub": "거장", "source": "guru"}


def test_후보는_12개까지():
    search_entities.load_sec_table_for_tests({f"SY{n:02d}": (f"{n:010d}", f"SYNTH COMPANY {n}") for n in range(30)})
    assert len(search.suggest("SYNTH COMPANY", owner=False)["items"]) == 12


# ------------------------------------------------------------------ Enter 후보

def test_Enter_후보는_로컬과_Wikidata_사람·조직·그밖_구분_중국어·같은_대상_빼고_topic이_맨_끝(monkeypatch):
    other_person = _entity("Q900021", en="Synth Founder", claims={"P31": [_claim("Q5")]})
    fund = _entity("Q900023", en="Synth Founder Fund", claims={"P31": [_claim("Q4230006")]})
    article = _entity("Q900024", en="Synth Founder profile", claims={"P31": [_claim("Q5633421")]})
    fake = _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("Synth Founder", "en"): [
            {"id": "Q900020", "label": "Synth Founder", "description": "synthetic businessperson"},
            {"id": "Q900021", "label": "Synth Founder", "description": "synthetic footballer"},
            {"id": "Q900022", "label": "合成创始人", "description": "合成人物"},
            {"id": "Q900023", "label": "Synth Founder Fund"},
            {"id": "Q900024", "label": "Synth Founder profile", "description": "synthetic magazine article"},
        ]},
        entities={"Q900020": SYNTH_PERSON, "Q900021": other_person, "Q900023": fund, "Q900024": article}))
    out = search.resolve("Synth Founder", owner=False, external=True)
    keys = [item["key"] for item in out["items"]]
    assert keys == ["wd:Q900020", "wd:Q900021", "wd:Q900023", "wd:Q900024", "topic:Synth Founder"]
    kinds = [item["kind"] for item in out["items"]]
    assert kinds == ["person", "person", "company", "topic", "topic"], "사람·조직이 아닌 항목(글·건물 등)은 company로 적지 않음"
    assert out["items"][0]["sub"] == "synthetic businessperson" and out["items"][2]["sub"] == "Wikidata"
    # 맨 끝 주제 후보의 부제는 null(계약 §3-1 '없으면 null' — 화면이 종류·출처 이름을 이미 붙임)
    assert out["items"][-1] == {"key": "topic:Synth Founder", "kind": "topic", "name": "Synth Founder", "sub": None,
                                "source": "topic"}
    assert out["errors"] == {}
    assert fake.calls[0]["language"] == "en" and fake.calls[0]["uselang"] == "en"
    assert len(fake.calls) == 2, "이름 찾기 1번 + 항목 읽기 1번"
    search.resolve("Synth Founder", owner=False, external=True)
    assert len(fake.calls) == 2, "1시간 캐시"


def test_Enter_후보의_상장사·13F_기관은_대표_키로(monkeypatch):
    _load_sec([("SCHP", "0009000001", "SYNTHCHIP CORP")])
    berkshire_like = _entity("Q900070", en="Synth Holdings", claims={"P31": [_claim("Q4830453")], "P5531": [_claim("0001067983")]})
    _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("SynthChip", "en"): [{"id": "Q900001", "label": "SynthChip", "description": "synthetic chip company"},
                                              {"id": "Q900070", "label": "Synth Holdings"}]},
        entities={"Q900001": SYNTH_CHIP, "Q900070": berkshire_like}))
    out = search.resolve("SynthChip", owner=False, external=True)
    keys = [item["key"] for item in out["items"]]
    assert keys[:2] == ["us:SCHP", "cik:0001067983"] or ("us:SCHP" in keys and "cik:0001067983" in keys)
    assert keys.count("us:SCHP") == 1, "로컬(SEC 표) 후보와 같은 키는 하나만"
    institution = next(item for item in out["items"] if item["key"] == "cik:0001067983")
    assert institution["kind"] == "institution" and institution["source"] == "wikidata"


def test_Enter_후보_한글이면_ko로_묻고_로컬과_같은_대상은_하나(monkeypatch):
    fake = _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("합성전자", "ko"): [{"id": "Q900050", "label": "합성전자", "description": "합성 기업"}]},
        entities={"Q900050": SYNTH_KR}))
    out = search.resolve("합성전자", owner=False, external=True)
    assert [item["key"] for item in out["items"]] == ["kr:900001", "kr:900002", "topic:합성전자"]
    assert fake.calls[0]["language"] == "ko"


def test_Enter_후보_외부_호출을_끄면_로컬과_주제만():
    out = search.resolve("합성전자", owner=False, external=False)
    assert [item["key"] for item in out["items"]] == ["kr:900001", "kr:900002", "topic:합성전자"]
    assert "wikidata" in out["errors"]


def test_Enter_후보_Wikidata_실패는_errors에(monkeypatch):
    _use_wikidata(monkeypatch, FakeWikidata(fail=True))
    out = search.resolve("Synth Founder", owner=False, external=True)
    assert out["errors"] == {"wikidata": "www.wikidata.org HTTP 503"}
    assert out["items"][-1]["key"] == "topic:Synth Founder"


def test_Enter_후보_키_없는_로컬_후보는_같은_이름의_Wikidata_사람을_가리지_않는다(monkeypatch):
    """13F 운용자·거장 이름(키 없음)과 이름이 같은 Wikidata 사람(wd:)은 남기고, 키 없는 로컬 쪽을 뺍니다(같은 대상을 둘로 보이지 않게)."""
    person = _entity("Q900060", ko="스탠리 드러켄밀러", en="Stanley Druckenmiller", claims={"P31": [_claim("Q5")]})
    row = {"id": "Q900060", "label": "스탠리 드러켄밀러", "description": "합성 투자자"}
    _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("스탠리 드러켄밀러", "ko"): [row], ("드러켄밀러", "ko"): [row]}, entities={"Q900060": person}))
    for query in ("스탠리 드러켄밀러", "드러켄밀러"):
        out = search.resolve(query, owner=False, external=True)
        people = [(item["key"], item["source"]) for item in out["items"] if item["kind"] == "person"]
        assert people == [("wd:Q900060", "wikidata")], query
        assert out["items"][-1]["key"] == f"topic:{query}"


def test_Enter_후보_키_없는_로컬_후보는_다른_이름의_Wikidata_후보가_있어도_남는다(monkeypatch):
    other = _entity("Q900061", ko="드러켄밀러 재단", claims={"P31": [_claim("Q43229")]})
    _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("드러켄밀러", "ko"): [{"id": "Q900061", "label": "드러켄밀러 재단"}]}, entities={"Q900061": other}))
    keys = [(item["key"], item["name"]) for item in search.resolve("드러켄밀러", owner=False, external=True)["items"]]
    assert (None, "스탠리 드러켄밀러") in keys and ("wd:Q900061", "드러켄밀러 재단") in keys


def test_Enter_후보_Wikidata가_늦으면_상한_시각에_로컬과_주제만(monkeypatch):
    monkeypatch.setattr(search, "RESOLVE_DEADLINE", 0.3)
    release = threading.Event()
    actions = []
    late = _entity("Q900080", en="Synth Late", claims={"P31": [_claim("Q5")]})

    def slow(params):
        actions.append(params.get("action"))
        release.wait(5)
        if params.get("action") == "wbsearchentities":
            return {"search": [{"id": "Q900080", "label": "Synth Late", "description": "synthetic person"}]}
        return {"entities": {"Q900080": late}}

    monkeypatch.setattr(search_wikidata, "api", slow)
    try:
        started = time.monotonic()
        out = search.resolve("Synth Late", owner=False, external=True)
        again = search.resolve("Synth Late", owner=False, external=True)
        assert time.monotonic() - started < 1.5, "두 번 모두 상한 시각에 답함"
        assert [item["key"] for item in out["items"]] == ["topic:Synth Late"]
        assert "초" in out["errors"]["wikidata"] and "Synth" not in out["errors"]["wikidata"]
        assert [item["key"] for item in again["items"]] == ["topic:Synth Late"]
    finally:
        release.set()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and search._get(("resolve-wd", "synth late")) is None:
        time.sleep(0.02)
    done = search.resolve("Synth Late", owner=False, external=True)
    assert [item["key"] for item in done["items"]] == ["wd:Q900080", "topic:Synth Late"], "늦게 끝난 찾기는 캐시에 남아 다음에 씀"
    assert done["errors"] == {}
    assert actions.count("wbsearchentities") == 1, "같은 검색어가 도는 중이면 다시 보내지 않음"


# ------------------------------------------------------------------ 대상 풀기

def test_미국_종목은_SEC와_Wikidata로_풀린다(monkeypatch):
    _load_sec([("SCHP", "0009000001", "SYNTHCHIP CORP /DE/")])
    fake = _use_wikidata(monkeypatch, FakeWikidata(cirrus={"P5531=0009000001": ["Q900001"]}, entities={"Q900001": SYNTH_CHIP}))
    out = search.entity("us:SCHP", external=True)
    entity = out["entity"]
    assert out["errors"] == {}
    assert entity["key"] == "us:SCHP" and entity["kind"] == "company"
    assert entity["name"] == "합성칩" and entity["nameKo"] == "합성칩" and entity["nameEn"] == "SynthChip"
    assert entity["description"] == "합성 반도체 기업"
    assert entity["ids"] == {"ticker": "SCHP", "market": "us", "stockCode": None, "cik": "0009000001", "dartCorpCode": None,
                             "wikidata": "Q900001", "lei": "SYNTHCHIPLEI000000" + "42"}
    assert entity["sources"] == ["sec", "wikidata"]
    assert "SynthChip Corporation" in entity["aliases"] and "합성칩 코퍼레이션" in entity["aliases"]
    assert "英伟达" not in entity["aliases"] and "SCHP" not in entity["aliases"]
    assert len({a.casefold() for a in entity["aliases"]}) == len(entity["aliases"])
    links = {(link["relation"], link["key"], link["name"], link["kind"], link["source"]) for link in entity["links"]}
    assert ("subsidiary", "wd:Q900010", "SynthChip Labs", None, "wikidata") in links
    assert ("ceo", "wd:Q900020", "신스 파운더", "person", "wikidata") in links, "관계 이름은 ko 먼저"
    assert ("founded_by", "wd:Q900020", "신스 파운더", None, "wikidata") in links
    assert all(call.get("languages", "ko|en") == "ko|en" for call in fake.calls if call.get("action") == "wbgetentities")
    before = len(fake.calls)
    search.entity("us:SCHP", external=True)
    assert len(fake.calls) == before, "하루 캐시"


def test_국내_종목은_DART_저장본과_티커로_확인한_Wikidata(monkeypatch):
    _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("합성전자", "ko"): [{"id": "Q900051", "label": "합성전자"}, {"id": "Q900050", "label": "합성전자"}]},
        entities={"Q900050": SYNTH_KR, "Q900051": SYNTH_KR_OTHER}))
    entity = search.entity("kr:900001", external=True)["entity"]
    assert entity["key"] == "kr:900001" and entity["kind"] == "company"
    assert entity["ids"]["wikidata"] == "Q900050", "동명 항목이 아니라 티커(P249)가 맞는 항목"
    assert entity["ids"]["stockCode"] == "900001" and entity["ids"]["dartCorpCode"] == "00900001"
    assert entity["ids"]["market"] == "kr" and entity["nameKo"] == "합성전자" and entity["nameEn"] == "Synthetic Electronics"
    assert entity["sources"] == ["dart", "wikidata"]
    assert "합성전자 주식회사" in entity["aliases"] and "합성" not in entity["aliases"], "네 글자 미만 별칭은 뺌"


def test_13F_기관은_운용자_연결이_있다(monkeypatch):
    _use_wikidata(monkeypatch, FakeWikidata())
    entity = search.entity("cik:0001536411", external=True)["entity"]
    assert entity["key"] == "cik:0001536411" and entity["kind"] == "institution"
    assert entity["nameKo"] == "듀케인 패밀리 오피스" and entity["nameEn"] == "Duquesne Family Office"
    assert entity["ids"]["cik"] == "0001536411" and entity["ids"]["wikidata"] is None
    assert {"relation": "manager", "key": None, "name": "스탠리 드러켄밀러", "kind": "person", "source": "13f",
            "detail": None} in entity["links"]
    assert entity["sources"] == ["13f"]


def test_사람은_소유·소속과_역방향_창업·대표_관계(monkeypatch):
    fake = _use_wikidata(monkeypatch, FakeWikidata(
        cirrus={"haswbstatement:P112=Q900020": ["Q900001", "Q900040"]}, entities={"Q900020": SYNTH_PERSON}))
    out = search.entity("wd:Q900020", external=True)
    entity = out["entity"]
    assert entity["key"] == "wd:Q900020" and entity["kind"] == "person"
    assert entity["name"] == "Synth Founder" and entity["nameKo"] is None
    links = {(link["relation"], link["key"], link["name"]) for link in entity["links"]}
    assert ("owner_of", "wd:Q900030", "Founder Holdings") in links
    assert ("employer", "wd:Q900001", "합성칩") in links
    assert ("founder_of", "wd:Q900040", "SynthChip Foundation") in links
    assert ("founder_of", "wd:Q900001", "합성칩") in links
    assert len(fake.calls) == 3, "항목 1 + 역방향 창업 1 + 이름 1 — Wikidata 호출을 아낌"


def test_운용자_이름의_사람은_13F_기관으로_이어진다(monkeypatch):
    person = _entity("Q900060", en="Stanley Druckenmiller", claims={"P31": [_claim("Q5")]})
    _use_wikidata(monkeypatch, FakeWikidata(entities={"Q900060": person}))
    entity = search.entity("wd:Q900060", external=True)["entity"]
    assert {"relation": "managed_by", "key": "cik:0001536411", "name": "듀케인 패밀리 오피스", "kind": "institution",
            "source": "13f", "detail": None} in entity["links"]


def test_Wikidata_항목이_상장사면_대표_키는_티커(monkeypatch):
    _load_sec([("SCHP", "0009000001", "SYNTHCHIP CORP")])
    _use_wikidata(monkeypatch, FakeWikidata(entities={"Q900001": SYNTH_CHIP, "Q900050": SYNTH_KR}))
    assert search.entity("wd:Q900001", external=True)["entity"]["key"] == "us:SCHP"
    kr = search.entity("wd:Q900050", external=True)["entity"]
    assert kr["key"] == "kr:900001" and kr["ids"]["dartCorpCode"] == "00900001"


def test_상장_티커는_거래소와_함께_읽고_미국·한국_거래소만_대표_키에_쓴다():
    foundry = search_wikidata.parse_entity(SYNTH_FOUNDRY)
    assert foundry["tickers"] == ["2330", "SFY"]
    assert foundry["us_tickers"] == ["SFY"] and foundry["kr_codes"] == []
    assert foundry["ciks"] == ["0009000091"]
    kr = search_wikidata.parse_entity(SYNTH_KR)
    assert kr["kr_codes"] == ["900001"] and kr["us_tickers"] == []
    abroad = search_wikidata.parse_entity(SYNTH_ABROAD_KR_CODE)
    assert abroad["kr_codes"] == [] and abroad["us_tickers"] == [] and abroad["tickers"] == ["900001"]
    assert {"Q13677", "Q82059"} <= search_wikidata.US_EXCHANGES and "Q495372" in search_wikidata.KR_EXCHANGES


def test_해외_거래소_티커가_다른_SEC_종목과_같아도_그_종목으로_풀지_않는다(monkeypatch):
    _load_sec([("SLX", "0009000099", "OTHER SYNTH CO")])
    _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("Synth Luxe", "en"): [{"id": "Q900090", "label": "Synth Luxe"}]}, entities={"Q900090": SYNTH_LUXE}))
    candidate = next(item for item in search.resolve("Synth Luxe", owner=False, external=True)["items"]
                     if item["source"] == "wikidata")
    assert candidate["key"] == "wd:Q900090" and candidate["kind"] == "company"
    entity = search.entity("wd:Q900090", external=True)["entity"]
    assert entity["key"] == "wd:Q900090" and entity["kind"] == "company"
    assert entity["ids"]["ticker"] is None and entity["ids"]["cik"] is None and entity["ids"]["market"] is None
    assert not [alias for alias in entity["aliases"] if "other synth" in alias.casefold()]


def test_본국_숫자_코드는_미국_티커가_되지_않는다(monkeypatch):
    """SEC 표가 메모리에 없거나 받지 못해도 해외 거래소의 '2330' 같은 코드는 us:가 아니고, 미국 거래소 티커(SFY)를 씁니다."""
    _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("Synth Foundry", "en"): [{"id": "Q900091", "label": "Synth Foundry"}]},
        entities={"Q900091": SYNTH_FOUNDRY}))
    candidate = next(item for item in search.resolve("Synth Foundry", owner=False, external=True)["items"]
                     if item["source"] == "wikidata")
    assert candidate["key"] == "us:SFY"

    def sec_down():
        raise search_entities.SecTableError("www.sec.gov HTTP 503")

    monkeypatch.setattr(search_entities, "_fetch_sec_table", sec_down)
    entity = search.entity("wd:Q900091", external=True)["entity"]
    assert entity["key"] == "us:SFY" and entity["ids"]["ticker"] == "SFY" and entity["ids"]["cik"] == "0009000091"


def test_항목의_CIK와_SEC_표의_CIK가_다르면_그_티커로_풀지_않는다(monkeypatch):
    _load_sec([("SFY", "0009000555", "SOMEONE ELSE INC")])
    _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("Synth Foundry", "en"): [{"id": "Q900091", "label": "Synth Foundry"}]},
        entities={"Q900091": SYNTH_FOUNDRY}))
    candidate = next(item for item in search.resolve("Synth Foundry", owner=False, external=True)["items"]
                     if item["source"] == "wikidata")
    assert candidate["key"] == "wd:Q900091"
    entity = search.entity("wd:Q900091", external=True)["entity"]
    assert entity["key"] == "wd:Q900091" and entity["ids"]["ticker"] is None
    assert "Someone Else" not in entity["aliases"]


def test_해외_거래소의_6자리_코드는_같은_국내_종목으로_풀지_않는다(monkeypatch):
    _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("합성해외", "ko"): [{"id": "Q900092", "label": "합성해외"}]},
        entities={"Q900092": SYNTH_ABROAD_KR_CODE}))
    candidate = next(item for item in search.resolve("합성해외", owner=False, external=True)["items"]
                     if item["source"] == "wikidata")
    assert candidate["key"] == "wd:Q900092"
    entity = search.entity("wd:Q900092", external=True)["entity"]
    assert entity["key"] == "wd:Q900092" and entity["ids"]["dartCorpCode"] is None and entity["ids"]["stockCode"] is None


def test_국내_종목의_Wikidata_확인은_한국_거래소의_코드만(monkeypatch):
    abroad_same_name = _entity("Q900093", ko="합성전자", claims={
        "P31": [_claim("Q4830453")], "P414": [_claim(FOREIGN_EXCHANGE, qualifiers={"P249": ["900001"]})]})
    _use_wikidata(monkeypatch, FakeWikidata(
        search_results={("합성전자", "ko"): [{"id": "Q900093", "label": "합성전자"}, {"id": "Q900050", "label": "합성전자"}]},
        entities={"Q900050": SYNTH_KR, "Q900093": abroad_same_name}))
    entity = search.entity("kr:900001", external=True)["entity"]
    assert entity["ids"]["wikidata"] == "Q900050"


def test_주제는_외부를_부르지_않는다():
    out = search.entity("topic:AI 반도체", external=True)
    assert out["entity"] == {"key": "topic:AI 반도체", "kind": "topic", "name": "AI 반도체", "nameKo": None, "nameEn": None,
                             "aliases": ["AI 반도체"], "description": None,
                             "ids": {"ticker": None, "market": None, "stockCode": None, "cik": None, "dartCorpCode": None,
                                     "wikidata": None, "lei": None},
                             "links": [], "sources": []}
    assert out["errors"] == {}


def test_외부_호출을_끄면_로컬만_Wikidata_항목은_없음():
    kr = search.entity("kr:900001", external=False)
    assert kr["entity"]["nameKo"] == "합성전자" and kr["entity"]["ids"]["wikidata"] is None
    assert "wikidata" in kr["errors"]
    us = search.entity("us:ZZZZ", external=False)
    assert us["entity"]["name"] == "ZZZZ" and us["entity"]["ids"]["cik"] is None
    wd = search.entity("wd:Q900001", external=False)
    assert wd["entity"] is None and "wikidata" in wd["errors"]


def test_Wikidata가_실패하면_로컬_대상과_사유(monkeypatch):
    _use_wikidata(monkeypatch, FakeWikidata(fail=True))
    out = search.entity("kr:900001", external=True)
    assert out["entity"]["nameKo"] == "합성전자" and out["errors"]["wikidata"] == "www.wikidata.org HTTP 503"


def test_SEC_표는_하루_캐시하고_실패하면_사유(monkeypatch):
    calls = []

    def fetch():
        calls.append(1)
        raise search_entities.SecTableError("SEC_USER_AGENT가 비어 SEC 표를 받지 못함")

    monkeypatch.setattr(search_entities, "_fetch_sec_table", fetch)
    _use_wikidata(monkeypatch, FakeWikidata())
    out = search.entity("us:SCHP", external=True)
    assert out["errors"]["sec"] == "SEC_USER_AGENT가 비어 SEC 표를 받지 못함"
    again = search.entity("us:SCHQ", external=True)
    assert len(calls) == 1, "실패한 뒤 60초 안에는 다시 받지 않음"
    assert again["errors"]["sec"] == "SEC_USER_AGENT가 비어 SEC 표를 받지 못함"


def test_Wikidata_요청은_1초_넘게_간격을_둔다(monkeypatch):
    from app import http

    paced = []
    monkeypatch.setattr(http, "pace", lambda host, interval, *a, **k: paced.append((host, interval)))

    class Session:
        def get(self, url, params=None, timeout=None, headers=None):
            return SimpleNamespace(status_code=200, json=lambda: {"search": []})

    search_wikidata.request({"action": "wbsearchentities", "search": "x", "language": "en"}, session=Session())
    assert paced == [("www.wikidata.org", search_wikidata.MIN_INTERVAL)] and search_wikidata.MIN_INTERVAL >= 1.0
