"""
app/services/search_entities.py
정보 검색(ADR 0041 결정 4)의 대상 풀기 — 로컬 색인(치는 동안의 후보)과 대상 하나의 속성·식별자·연결.

로컬 색인(바깥 호출 없음)
- DART 고유번호 저장본(``kr.dart_corp_codes`` — 상장사), 13F 기관 목록(``indicators.INSTITUTIONS`` 12곳)과 그 소개에 적힌 운용자, 13F 종목 매핑표
  (``equities.EQUITY_MAP`` — 13F 공시 이름 → 티커), 메모리에 이미 있는 SEC 티커 표(여기서는 받지 않음), 거장 이름(운영자에게만).
대상 풀기
- ``us:`` SEC ``company_tickers.json``(이름이 필요해 ``sec_fundamentals``의 요청 함수로 받아 이름까지 읽음 — 메모리 하루) → CIK·이름,
  Wikidata(CIK ``P5531`` 또는 영어 이름 — 티커·CIK로 확인한 항목만).
- ``kr:`` DART 저장본 → 고유번호·이름, Wikidata(한국어 이름 — 티커 한정자 P249가 종목코드와 같은 항목, 없으면 라벨이 같은 조직).
- ``cik:`` 13F 목록(이름·운용자), Wikidata(CIK 또는 영어 이름이 같은 항목).
- ``wd:`` Wikidata — 상장사면 대표 키를 ``us:``/``kr:``로(미국·한국 거래소 문장의 티커만 — 미국은 SEC 표에 있고 항목의 CIK와 같을 때,
  한국은 DART 저장본에 있을 때), 13F 기관(CIK)이면 ``cik:``로 바꿉니다.
- 연결: Wikidata 관계(이름은 ko·en 라벨) + 13F 운용자↔기관.
외부 호출을 끈 요청(``external=false``)은 로컬 색인과 메모리에 있는 것만 씁니다.
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from .. import equities, http, indicators
from . import search_rules as rules
from . import search_store, sec_fundamentals
from . import search_wikidata as wd

OFFLINE = "외부 호출을 끈 요청이라 부르지 않음(저장본만)"
LOCAL_TTL = 600.0
LOCAL_EMPTY_TTL = 60.0
SEC_TTL = 86_400.0
SEC_FAILURE_TTL = 60.0
SUGGEST_LIMIT = 12
US_TICKER = re.compile(r"^[A-Z0-9.\-]{1,15}$")
KR_CODE = re.compile(r"^\d{6}$")

# 13F 기관의 운용자 — 기관 소개(indicators.INSTITUTIONS의 desc)에 이름이 적힌 사람만. (한국어, 영어)
MANAGERS: dict[str, tuple[tuple[str, str], ...]] = {
    "0001536411": (("스탠리 드러켄밀러", "Stanley Druckenmiller"),),
    "0000850529": (("켄 피셔", "Ken Fisher"),),
    "0001350694": (("레이 달리오", "Ray Dalio"),),
    "0001649339": (("마이클 버리", "Michael Burry"),),
}
SOURCE_RANK = {"13f": 0, "dart": 1, "universe": 2, "sec": 3, "guru": 4}

_CORP_SUFFIXES = {"CORP", "CORPORATION", "INC", "INCORPORATED", "CO", "COMPANY", "LTD", "LIMITED", "PLC", "LLC", "LP", "L P",
                  "NV", "N V", "SA", "S A", "AG", "SE", "CL A", "CLASS A", "THE"}


# ------------------------------------------------------------------ 이름 다듬기

def clean_company_name(title: str | None) -> str | None:
    """SEC·13F 법인 이름 → 검색에 쓸 이름(끝의 '/DE/'·'CORP'·'INC.' 같은 꼬리를 뗌). 남는 것이 없으면 None."""
    text = re.sub(r"(\s*/[A-Za-z]{2,3}/)+\s*$", "", (title or "").strip())
    words = text.replace(",", " ").split()
    while words:
        tail2 = " ".join(words[-2:]).upper().replace(".", " ").strip() if len(words) >= 2 else ""
        tail1 = words[-1].upper().replace(".", " ").strip()
        if len(words) >= 2 and " ".join(tail2.split()) in _CORP_SUFFIXES:
            words = words[:-2]
        elif " ".join(tail1.split()) in _CORP_SUFFIXES:
            words = words[:-1]
        else:
            break
    cleaned = " ".join(words).strip(" .&-")
    return cleaned or None


def _institution_rows() -> list[dict]:
    rows = []
    for inst in indicators.INSTITUTIONS:
        raw = re.sub(r"^[^\w(]+", "", inst["name"]).strip()      # 앞의 국기 그림 글자를 뗌
        match = re.match(r"^(.*?)\s*\((.*)\)\s*$", raw)
        ko, english = (match.group(1).strip(), match.group(2).strip()) if match else (raw, "")
        parts = [part.strip() for part in re.split(r"\s+[/\-–]\s+", english) if part.strip()]
        rows.append({"cik": inst["cik"], "ko": ko, "en": parts[0] if parts else None, "aliases": parts[1:],
                     "desc": inst.get("desc")})
    return rows


INSTITUTION_ROWS = _institution_rows()
INSTITUTIONS_BY_CIK = {row["cik"]: row for row in INSTITUTION_ROWS}


# ------------------------------------------------------------------ SEC 티커 표(메모리 하루)

class SecTableError(RuntimeError):
    """SEC 티커 표를 받지 못함 — 화면용 한 줄."""


def parse_company_tickers(data: Any) -> dict[str, tuple[str, str]]:
    """``company_tickers.json`` → {티커(대문자): (CIK 10자리, 이름)}. 같은 티커가 여러 행이면 앞의 것."""
    table: dict[str, tuple[str, str]] = {}
    rows = data.values() if isinstance(data, dict) else []
    for row in rows:
        if not isinstance(row, dict):
            continue
        ticker = str(row.get("ticker") or "").strip().upper()
        cik = row.get("cik_str")
        title = str(row.get("title") or "").strip()
        if ticker and US_TICKER.match(ticker) and cik is not None and str(cik).isdigit() and title:
            table.setdefault(ticker, (str(cik).zfill(10), title))
    return table


def _sec_reason(text: str) -> str:
    """SEC 요청 실패 글 → 호스트와 상태만(연결 실패 글에는 요청 주소가 섞일 수 있어 옮기지 않음)."""
    status = re.search(r"SEC 응답 (\d{3})", text)
    if status:
        hint = " — SEC_USER_AGENT에 본인 이메일을 넣으세요" if status.group(1) == "403" else ""
        return f"www.sec.gov HTTP {status.group(1)}{hint}"
    if http.REJECTED_MARK in text:
        return text[text.index(http.REJECTED_MARK):]
    return "www.sec.gov 연결·응답 실패"


def _fetch_sec_table() -> dict[str, tuple[str, str]]:
    """SEC 표 받기(``SEC_USER_AGENT`` 세션·토큰 버킷 — ``sec_fundamentals``의 요청 함수 그대로). 실패는 :class:`SecTableError`."""
    try:
        session = http.get_sec_session()
    except http.SecUserAgentInvalid:
        raise SecTableError("SEC_USER_AGENT가 비어 있거나 올바르지 않아 SEC 표를 받지 못함") from None
    try:
        data = sec_fundamentals._get_json(session, sec_fundamentals.COMPANY_TICKERS_URL)
    except sec_fundamentals.FetchError as exc:
        raise SecTableError(_sec_reason(str(exc))) from None
    table = parse_company_tickers(data)
    if not table:
        raise SecTableError("SEC 티커 표의 모양이 예상과 다름")
    return table


_sec_lock = threading.Lock()
_sec_fetch_lock = threading.Lock()
_sec_state: dict[str, Any] = {"table": None, "until": 0.0, "failed_until": 0.0, "error": None}
_sec_reverse: dict[str, Any] = {"of": None, "by_cik": {}}


def sec_table(*, fetch: bool) -> tuple[dict | None, str | None]:
    """
    SEC 티커 표 → (표 또는 None, 사유). ``fetch``가 거짓이면 메모리에 있는 것만(기한이 지났어도) 돌려주고 받지 않습니다.
    실패하면 SEC_FAILURE_TTL 동안 다시 받지 않고 그 사유를 돌려줍니다.
    """
    with _sec_lock:
        table, until, failed_until, error = (_sec_state["table"], _sec_state["until"], _sec_state["failed_until"],
                                             _sec_state["error"])
    now = time.monotonic()
    if table is not None and (until > now or not fetch):
        return table, None
    if not fetch:
        return None, None
    if failed_until > now:
        return table, error
    with _sec_fetch_lock:
        with _sec_lock:
            if _sec_state["table"] is not None and _sec_state["until"] > time.monotonic():
                return _sec_state["table"], None
        try:
            fresh = _fetch_sec_table()
        except SecTableError as exc:
            with _sec_lock:
                _sec_state.update(failed_until=time.monotonic() + SEC_FAILURE_TTL, error=str(exc))
            return table, str(exc)
        with _sec_lock:
            _sec_state.update(table=fresh, until=time.monotonic() + SEC_TTL, failed_until=0.0, error=None)
        return fresh, None


def load_sec_table_for_tests(table: dict[str, tuple[str, str]]) -> None:
    """시험용 — SEC 표를 메모리에 넣습니다(받은 것처럼)."""
    with _sec_lock:
        _sec_state.update(table=dict(table), until=time.monotonic() + SEC_TTL, failed_until=0.0, error=None)


def sec_lookup(ticker: str, table: dict | None) -> tuple[str, str, str] | None:
    """티커 → (표의 티커, CIK, 이름). 'BRK.B'·'BRK-B'를 함께 봅니다."""
    if not table:
        return None
    for form in dict.fromkeys([ticker.upper(), ticker.upper().replace(".", "-"), ticker.upper().replace("-", ".")]):
        row = table.get(form)
        if row:
            return form, row[0], row[1]
    return None


def us_listing(parsed: dict, table: dict | None) -> str | None:
    """
    Wikidata 항목 → 미국 대표 키에 쓸 티커(없으면 None). 미국 거래소 문장의 티커만 보고(해외 거래소의 같은 티커를 다른 회사로 풀지 않게),
    SEC 표에 있으면 표의 티커 — 항목에 CIK(P5531)가 있으면 표의 CIK가 그중 하나여야 합니다. SEC 표가 없을 때는 CIK가 있는 항목의
    미국 거래소 티커를 그대로 씁니다.
    """
    for ticker in parsed.get("us_tickers") or []:
        if not US_TICKER.match(ticker.upper()):
            continue
        found = sec_lookup(ticker, table)
        if found:
            if parsed.get("ciks") and found[1] not in parsed["ciks"]:
                continue
            return found[0]
        if table is None and parsed.get("cik"):
            return ticker.upper()
    return None


def kr_listing(parsed: dict, dart_codes) -> str | None:
    """Wikidata 항목 → 국내 대표 키에 쓸 종목코드 — 한국 거래소 문장의 6자리 코드 중 DART 저장본에 있는 것(없으면 None)."""
    return next((code for code in parsed.get("kr_codes") or [] if KR_CODE.match(code) and code in dart_codes), None)


def _institution_cik(parsed: dict) -> str | None:
    return next((cik for cik in parsed.get("ciks") or [] if cik in INSTITUTIONS_BY_CIK), None)


def sec_by_cik(cik: str, table: dict | None) -> tuple[str, str] | None:
    """CIK → (티커, 이름) — 표의 첫 행."""
    if not table:
        return None
    with _sec_lock:
        if _sec_reverse["of"] is not table:
            reverse: dict[str, tuple[str, str]] = {}
            for ticker, (row_cik, title) in table.items():
                reverse.setdefault(row_cik, (ticker, title))
            _sec_reverse.update(of=table, by_cik=reverse)
        return _sec_reverse["by_cik"].get(cik)


# ------------------------------------------------------------------ 로컬 색인

@dataclass(frozen=True)
class LocalEntry:
    key: str | None
    kind: str
    name: str
    sub: str | None
    source: str
    terms: tuple[str, ...]      # 대조할 이름(casefold)
    code: str | None = None     # 티커·종목코드(casefold)

    def candidate(self) -> dict:
        return {"key": self.key, "kind": self.kind, "name": self.name, "sub": self.sub, "source": self.source}


def _fold(text: str | None) -> str:
    return " ".join((text or "").split()).casefold()


def _static_entries() -> list[LocalEntry]:
    entries = []
    for row in INSTITUTION_ROWS:
        names = [row["ko"], row["en"], *row["aliases"]]
        entries.append(LocalEntry(f"cik:{row['cik']}", "institution", row["ko"], f"13F 기관 · CIK {row['cik']}", "13f",
                                  tuple(_fold(n) for n in names if n)))
        for ko, en in MANAGERS.get(row["cik"], ()):
            entries.append(LocalEntry(None, "person", ko, f"13F 운용자 · {row['ko']}", "13f", (_fold(ko), _fold(en))))
    seen: set[str] = set()
    for name, (ticker, _sector) in equities.EQUITY_MAP.items():
        if not ticker or ticker in seen or not US_TICKER.match(ticker.upper()):
            continue
        seen.add(ticker)
        entries.append(LocalEntry(f"us:{ticker.upper()}", "company", name, f"{ticker.upper()} · 미국", "universe",
                                  (_fold(name),), _fold(ticker)))
    return entries


_STATIC = _static_entries()
_local_lock = threading.Lock()
_local: dict[str, tuple[float, list[LocalEntry]]] = {}
_sec_entries: dict[str, Any] = {"of": None, "entries": []}


def _cached_entries(name: str, build: Callable[[], list[LocalEntry]]) -> list[LocalEntry]:
    now = time.monotonic()
    with _local_lock:
        hit = _local.get(name)
    if hit is not None and hit[0] > now:
        return hit[1]
    entries = build()
    with _local_lock:
        _local[name] = (time.monotonic() + (LOCAL_TTL if entries else LOCAL_EMPTY_TTL), entries)
    return entries


def _dart_entries() -> list[LocalEntry]:
    return [LocalEntry(f"kr:{code}", "company", row["name"], f"{code} · 한국", "dart", (_fold(row["name"]),), code)
            for code, row in search_store.dart_codes().items()]


def _guru_entries() -> list[LocalEntry]:
    return [LocalEntry(None, "person", name, "거장", "guru", (_fold(name),)) for name in search_store.guru_names()]


def _sec_index() -> list[LocalEntry]:
    table, _ = sec_table(fetch=False)
    if not table:
        return []
    with _local_lock:
        if _sec_entries["of"] is table:
            return _sec_entries["entries"]
    entries = [LocalEntry(f"us:{ticker}", "company", title, f"{ticker} · 미국", "sec", (_fold(title),), _fold(ticker))
               for ticker, (_cik, title) in table.items()]
    with _local_lock:
        _sec_entries.update(of=table, entries=entries)
    return entries


def _score(entry: LocalEntry, query: str) -> int | None:
    best = None
    if entry.code is not None:
        if entry.code == query:
            return 0
        if entry.code.startswith(query):
            best = 1
    for term in entry.terms:
        if term == query:
            return 0
        if term.startswith(query):
            best = 1
        elif query in term and best is None:
            best = 2
    return best


def local_candidates(q: str, *, owner: bool, limit: int = SUGGEST_LIMIT) -> list[dict]:
    """로컬 색인에서 후보 — 완전 일치 > 앞부분 일치 > 포함, 같으면 13F > DART > 종목 매핑표 > SEC > 거장. 바깥 호출 없음."""
    query = _fold(q)
    if not query:
        return []
    pools = [_STATIC, _cached_entries("dart", _dart_entries), _sec_index()]
    if owner:
        pools.append(_cached_entries("guru", _guru_entries))
    scored = []
    for pool in pools:
        for entry in pool:
            score = _score(entry, query)
            if score is not None:
                scored.append((score, SOURCE_RANK.get(entry.source, 9), len(entry.name), entry.name, entry))
    scored.sort(key=lambda row: row[:4])
    out, seen = [], set()
    for *_, entry in scored:
        mark = entry.key or f"{entry.kind}:{entry.name.casefold()}"
        if mark in seen:
            continue
        seen.add(mark)
        out.append(entry.candidate())
        if len(out) >= limit:
            break
    return out


def reset() -> None:
    """시험용 — 로컬 색인 캐시와 SEC 표를 비웁니다."""
    with _local_lock:
        _local.clear()
        _sec_entries.update(of=None, entries=[])
    with _sec_lock:
        _sec_state.update(table=None, until=0.0, failed_until=0.0, error=None)
        _sec_reverse.update(of=None, by_cik={})


# ------------------------------------------------------------------ 대상 풀기

def empty_ids() -> dict:
    return {"ticker": None, "market": None, "stockCode": None, "cik": None, "dartCorpCode": None, "wikidata": None}


def topic_entity(text: str) -> dict:
    return {"key": f"topic:{text}", "kind": "topic", "name": text, "nameKo": None, "nameEn": None, "aliases": [text],
            "description": None, "ids": empty_ids(), "links": [], "sources": []}


class _Builder:
    """대상 하나를 모으는 자리 — 출처마다 칸을 채우고 마지막에 계약 모양(Entity)으로."""

    def __init__(self, external: bool) -> None:
        self.external = external
        self.errors: dict[str, str] = {}
        self.sources: list[str] = []
        self.key: str | None = None
        self.kind: str | None = None
        self.name_ko: str | None = None
        self.name_en: str | None = None
        self.fallback: str | None = None
        self.aliases: list[str] = []
        self.description: str | None = None
        self.local_description: str | None = None
        self.ids = empty_ids()
        self.links: list[dict] = []
        self.parsed: dict | None = None
        self._wd_failed = False
        self._dart: dict | None = None

    def add_source(self, name: str) -> None:
        if name not in self.sources:
            self.sources.append(name)

    def dart(self) -> dict:
        if self._dart is None:
            self._dart = search_store.dart_codes()
        return self._dart

    def call_wd(self, fn: Callable, *args, **kwargs):
        """Wikidata 한 번 — 외부 호출을 껐거나 이미 실패했으면 부르지 않음. 실패는 errors['wikidata']에 한 줄."""
        if not self.external:
            self.errors.setdefault("wikidata", OFFLINE)
            return None
        if self._wd_failed:
            return None
        try:
            return fn(*args, **kwargs)
        except wd.WikidataError as exc:
            self._wd_failed = True
            self.errors["wikidata"] = str(exc)
            return None

    def sec(self) -> dict | None:
        table, error = sec_table(fetch=self.external)
        if error:
            self.errors.setdefault("sec", error)
        elif table is None and not self.external:
            self.errors.setdefault("sec", OFFLINE)
        return table

    def finish(self) -> dict:
        names = [name for name in (self.name_ko, self.name_en) if name]
        ticker = self.ids.get("ticker")
        aliases = [alias for alias in self.aliases if rules.usable_alias(alias, ticker)]
        merged = rules.dedupe_texts(names + aliases)
        return {
            "key": self.key, "kind": self.kind or "company",
            "name": self.name_ko or self.name_en or self.fallback or self.key,
            "nameKo": self.name_ko, "nameEn": self.name_en, "aliases": merged,
            "description": self.description or self.local_description,
            "ids": self.ids, "links": self.links, "sources": self.sources,
        }


def wd_candidate(qid: str, label: str, description: str | None, parsed: dict | None) -> dict:
    """
    Wikidata 후보 한 줄 — 항목의 주장으로 종류와 대표 키를 정합니다. 사람(P31=Q5) → person, 13F 기관의 CIK → ``cik:``·institution,
    한국 거래소 코드 중 DART 저장본에 있는 것 → ``kr:``, 미국 거래소 티커 중 메모리의 SEC 표에 있고 CIK가 맞는 것(SEC 표가 없으면 CIK가 있는
    항목의 미국 거래소 티커) → ``us:``(:func:`us_listing`), 조직 근거만 있으면 company, 어느 것도 아니면(글·건물·개념 등) topic.
    바깥 호출은 하지 않습니다(DART·SEC는 이미 가진 것만).
    """
    out = {"key": f"wd:{qid}", "kind": "topic", "name": label, "sub": rules.clip(description, 80) or "Wikidata",
           "source": "wikidata"}
    if parsed is None:
        return out
    if parsed["human"]:
        return dict(out, kind="person")
    institution = _institution_cik(parsed)
    if institution:
        return dict(out, key=f"cik:{institution}", kind="institution")
    code = kr_listing(parsed, {entry.code for entry in _cached_entries("dart", _dart_entries)})
    if code:
        return dict(out, key=f"kr:{code}", kind="company")
    ticker = us_listing(parsed, sec_table(fetch=False)[0])
    if ticker:
        return dict(out, key=f"us:{ticker}", kind="company")
    if parsed["organization"] or parsed["cik"] or parsed["tickers"]:
        return dict(out, kind="company")
    return out


def _first(parsed_by_id: dict | None, order: list[str], accept: Callable[[dict], bool]) -> dict | None:
    for qid in order:
        parsed = (parsed_by_id or {}).get(qid)
        if parsed is not None and accept(parsed):
            return parsed
    return None


def _wd_by_cik(b: _Builder, cik: str) -> dict | None:
    found = b.call_wd(wd.cirrus, f"haswbstatement:P5531={cik}|P5531={int(cik)}", 5)
    if not found:
        return None
    entities = b.call_wd(wd.get_entities, found[:5])
    return _first(entities, found[:5], lambda parsed: cik in parsed["ciks"])


def _wd_by_name(b: _Builder, name: str | None, lang: str, accept: Callable[[dict], bool],
                fallback: Callable[[dict], bool] | None = None) -> dict | None:
    if not name:
        return None
    results = b.call_wd(wd.search, name, lang, 5)
    if not results:
        return None
    order = [row["id"] for row in results]
    entities = b.call_wd(wd.get_entities, order)
    return _first(entities, order, accept) or (_first(entities, order, fallback) if fallback else None)


def _same_label(parsed: dict, name: str) -> bool:
    wanted = name.casefold()
    values = list(parsed["labels"].values()) + parsed["aliases"].get("ko", []) + parsed["aliases"].get("en", [])
    return any(value.casefold() == wanted for value in values)


def _apply_wd(b: _Builder, parsed: dict, *, prefer_wd_english: bool) -> None:
    b.parsed = parsed
    b.ids["wikidata"] = parsed["id"]
    b.add_source("wikidata")
    labels = parsed["labels"]
    if labels.get("ko") and not rules.is_chinese_title(labels["ko"]):
        if b.name_ko is None:
            b.name_ko = labels["ko"]
        else:
            b.aliases.append(labels["ko"])
    if labels.get("en"):
        if b.name_en is None or prefer_wd_english:
            if b.name_en and b.name_en != labels["en"]:
                b.aliases.append(b.name_en)
            b.name_en = labels["en"]
        else:
            b.aliases.append(labels["en"])
    b.aliases.extend(parsed["aliases"].get("ko", []) + parsed["aliases"].get("en", []))
    descriptions = parsed["descriptions"]
    b.description = descriptions.get("ko") or descriptions.get("en") or b.description
    if b.ids["cik"] is None and parsed["cik"]:
        b.ids["cik"] = parsed["cik"]


def _wd_links(b: _Builder) -> None:
    parsed = b.parsed
    if parsed is None:
        return
    pairs = list(parsed["relations"])
    if parsed["human"]:
        for pid, relation in wd.REVERSE_PROPS.items():
            found = b.call_wd(wd.cirrus, f"haswbstatement:{pid}={parsed['id']}", wd.MAX_LINKS_PER_RELATION) or []
            pairs.extend((relation, qid) for qid in found)
    pairs = [(relation, qid) for relation, qid in dict.fromkeys(pairs) if qid != parsed["id"]]
    if not pairs:
        return
    labels = b.call_wd(wd.get_entities, [qid for _, qid in pairs], labels_only=True) or {}
    for relation, qid in pairs:
        target = labels.get(qid)
        name = wd.label_of(target["labels"]) if target else None
        if not name or rules.is_chinese_title(name):
            continue
        kind = "person" if relation == "ceo" else "company" if relation == "ceo_of" else None
        b.links.append({"relation": relation, "key": f"wd:{qid}", "name": name, "kind": kind, "source": "wikidata"})


def _manager_links(b: _Builder) -> None:
    if b.kind == "institution":
        for ko, _en in MANAGERS.get(b.ids["cik"] or "", ()):
            b.links.append({"relation": "manager", "key": None, "name": ko, "kind": "person", "source": "13f"})
    elif b.kind == "person":
        names = {name.casefold() for name in [b.name_ko, b.name_en, *b.aliases] if name}
        for cik, managers in MANAGERS.items():
            if any(ko.casefold() in names or en.casefold() in names for ko, en in managers):
                b.links.append({"relation": "managed_by", "key": f"cik:{cik}", "name": INSTITUTIONS_BY_CIK[cik]["ko"],
                                "kind": "institution", "source": "13f"})


def _apply_institution(b: _Builder, cik: str) -> bool:
    row = INSTITUTIONS_BY_CIK.get(cik)
    if row is None:
        return False
    b.key, b.kind = f"cik:{cik}", "institution"
    b.ids["cik"] = cik
    b.name_ko = b.name_ko or row["ko"]
    if row["en"]:
        if b.name_en and b.name_en.casefold() != row["en"].casefold():
            b.aliases.append(b.name_en)
        b.name_en = row["en"]
    b.aliases.extend(row["aliases"])
    b.local_description = row["desc"]
    b.add_source("13f")
    return True


def _apply_us(b: _Builder, ticker: str, table: dict | None) -> None:
    b.key, b.kind = f"us:{ticker}", "company"
    b.ids.update(ticker=ticker, market="us")
    found = sec_lookup(ticker, table)
    if found:
        _, cik, title = found
        b.ids["cik"] = b.ids["cik"] or cik
        cleaned = clean_company_name(title)
        if cleaned:
            if b.name_en is None:
                b.name_en = cleaned
            else:
                b.aliases.append(cleaned)
        b.add_source("sec")
    b.fallback = b.fallback or ticker


def _apply_kr(b: _Builder, code: str) -> bool:
    row = b.dart().get(code)
    b.key, b.kind = f"kr:{code}", "company"
    b.ids.update(ticker=code, market="kr", stockCode=code)
    b.fallback = b.fallback or code
    if row is None:
        return False
    b.ids["dartCorpCode"] = row["corpCode"]
    if b.name_ko and b.name_ko != row["name"]:
        b.aliases.append(b.name_ko)
    b.name_ko = row["name"]
    b.add_source("dart")
    return True


def _build_us(b: _Builder, ticker: str) -> None:
    table = b.sec()
    _apply_us(b, ticker, table)
    if b.name_en is None:
        for name, (mapped, _sector) in equities.EQUITY_MAP.items():
            if mapped and mapped.upper() == ticker:
                b.name_en = clean_company_name(name)
                b.add_source("universe")
                break
    parsed = _wd_by_cik(b, b.ids["cik"]) if b.ids["cik"] else None
    if parsed is None:
        parsed = _wd_by_name(b, b.name_en, "en", lambda p: any(rules.same_ticker(t, ticker) for t in p["us_tickers"])
                             or (b.ids["cik"] is not None and b.ids["cik"] in p["ciks"]))
    if parsed is not None:
        _apply_wd(b, parsed, prefer_wd_english=True)
    _wd_links(b)


def _build_kr(b: _Builder, code: str) -> None:
    if not _apply_kr(b, code):
        b.errors.setdefault("dart", "DART 고유번호 저장본에 이 종목이 없음")
    parsed = _wd_by_name(b, b.name_ko, "ko", lambda p: code in p["kr_codes"],
                         lambda p: bool(b.name_ko) and p["organization"] and not p["human"] and _same_label(p, b.name_ko))
    if parsed is not None:
        _apply_wd(b, parsed, prefer_wd_english=False)
    _wd_links(b)


def _build_cik(b: _Builder, cik: str) -> None:
    if not _apply_institution(b, cik):
        b.key, b.kind = f"cik:{cik}", "institution"
        b.ids["cik"] = cik
        found = sec_by_cik(cik, b.sec())
        if found:
            b.name_en = clean_company_name(found[1]) or found[1]
            b.add_source("sec")
        b.fallback = f"CIK {cik}"
    parsed = _wd_by_cik(b, cik)
    if parsed is None and b.name_en:
        name = b.name_en
        parsed = _wd_by_name(b, name, "en", lambda p: cik in p["ciks"],
                             lambda p: p["organization"] and not p["human"] and _same_label(p, name))
    if parsed is not None:
        _apply_wd(b, parsed, prefer_wd_english=False)
    _manager_links(b)
    _wd_links(b)


def _build_wd(b: _Builder, qid: str) -> bool:
    entities = b.call_wd(wd.get_entities, [qid])
    parsed = (entities or {}).get(qid)
    if parsed is None:
        if entities is not None:
            b.errors["wikidata"] = "Wikidata에 이 항목이 없음"
        return False
    b.key = f"wd:{qid}"
    if parsed["human"]:
        b.kind = "person"
    _apply_wd(b, parsed, prefer_wd_english=True)
    if not parsed["human"]:
        institution = _institution_cik(parsed)
        if institution:
            _apply_institution(b, institution)
        else:
            listed = kr_listing(parsed, b.dart())
            if listed:
                _apply_kr(b, listed)
            elif parsed["us_tickers"]:
                table = b.sec()
                ticker = us_listing(parsed, table)
                if ticker:
                    _apply_us(b, ticker, table)
        if b.kind is None:
            b.kind = "company" if (parsed["organization"] or parsed["cik"] or parsed["tickers"]) else "topic"
    b.fallback = qid
    _manager_links(b)
    _wd_links(b)
    return True


def build(prefix: str, value: str, *, external: bool) -> dict:
    """대상 키(검사를 거친 것) → {entity, errors}. 'topic'은 외부를 부르지 않습니다."""
    if prefix == "topic":
        return {"entity": topic_entity(value), "errors": {}}
    b = _Builder(external)
    if prefix == "us":
        _build_us(b, value)
    elif prefix == "kr":
        _build_kr(b, value)
    elif prefix == "cik":
        _build_cik(b, value)
    elif prefix == "wd":
        if not _build_wd(b, value):
            return {"entity": None, "errors": b.errors}
    else:
        raise ValueError(f"모르는 대상 키 종류: {prefix}")
    return {"entity": b.finish(), "errors": b.errors}
