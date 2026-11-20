"""
app/services/kisa_notices.py
보안 공지(ADR 0046) — KISA 보호나라 보안공지 게시판의 목록·상세 HTML 읽기. 네트워크와 DB를 모릅니다(받기·저장은 tasks/security.py).

[목록] ``parse_list`` — 게시판 표(번호·제목·게시일 칸)의 줄마다 글 번호(nttId)·제목·게시일·번호 칸. 번호 칸이 '공지'인 줄은 고정 공지
  (``pinned``, 번호 없음). 같은 쪽에 같은 글이 고정 공지와 번호 줄로 함께 나오면 한 건으로 합칩니다. 글이 없는 쪽(칸 하나짜리 안내 줄)은 빈 목록.
[상세] ``parse_detail`` — 제목·게시일, 본문의 틀(``product_table`` — 취약점·제품명·영향받는 버전·해결 버전 4열 표가 하나라도 있음 /
  ``other_table`` — 다른 표만 / ``no_table``), 4열 표의 행(칸 글자 원문 그대로 — 여러 줄로 묶인 칸(rowspan)은 아래 줄에 같은 글자를 채움),
  제품명 고유 값(처음 나온 순서), 표 밖의 '※' 문장, 4열 표를 뺀 본문 글자(다른 표의 글자는 남김).
  **버전 칸은 해석하지 않습니다** — 영향받는 버전·해결 버전의 해석과 판정은 백엔드가 읽을 때 합니다(ADR 0046 결정 5).

틀이 깨지면(목록 표·필수 칸·상세 본문 자리가 없음, 4열 표의 줄 칸 수가 다름) ``info_text.ShapeError`` — 태스크가 출처 상태를 '형식 바뀜'으로
남깁니다(ADR 0046 결정 4).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from urllib.parse import parse_qs, urlsplit

from bs4 import BeautifulSoup

from .info_text import ShapeError, html_to_text

BASE = "https://www.boho.or.kr"
BBS_ID = "B0000133"
MENU_NO = "205020"
# 4열 표의 머리(칸 글자에서 빈칸을 뺀 것).
PRODUCT_HEADER = ("취약점", "제품명", "영향받는버전", "해결버전")
# 상한 — 비정상으로 큰 응답이 표에 그대로 들어가지 않게.
MAX_ROWS = 2000
MAX_CELL_CHARS = 500
MAX_NOTE_CHARS = 1000
MAX_BODY_CHARS = 40_000

_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_SPACES = re.compile(r"\s+")


def list_url(page: int = 1) -> str:
    """목록 ``page``쪽 주소(1부터)."""
    return f"{BASE}/kr/bbs/list.do?menuNo={MENU_NO}&bbsId={BBS_ID}&pageIndex={int(page)}"


def detail_url(ntt_id: int) -> str:
    """글 한 건의 주소(검색어·쪽 번호 인자 없음 — 화면의 원문 링크도 이 주소)."""
    return f"{BASE}/kr/bbs/view.do?menuNo={MENU_NO}&bbsId={BBS_ID}&nttId={int(ntt_id)}"


@dataclass(frozen=True)
class ListItem:
    ntt_id: int
    title: str
    posted_on: date
    pinned: bool
    list_no: int | None       # 번호 칸(고정 공지로만 보이면 None)
    url: str


@dataclass(frozen=True)
class Row:
    """4열 표 한 행 — 칸 글자 원문 그대로."""

    cve: str
    product: str
    affected: str
    fixed: str


@dataclass(frozen=True)
class Detail:
    title: str
    posted_on: date
    layout: str                # product_table | other_table | no_table
    rows: tuple[Row, ...]
    products: tuple[str, ...]
    notes: tuple[str, ...]
    body_text: str


def _text(node) -> str:
    return _SPACES.sub(" ", node.get_text(" ", strip=True)).strip()


def _date(text: str, what: str) -> date:
    match = _DATE.match(text.strip())
    if not match:
        raise ShapeError(f"{what} 게시일 모양이 다름")
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        raise ShapeError(f"{what} 게시일이 날짜가 아님") from None


def _header(table) -> list[str]:
    """표 머리 칸 — thead의 th, 없으면 첫 줄이 모두 th일 때 그 줄."""
    head = table.find("thead")
    if head is not None:
        cells = head.find_all(["th", "td"])
        if cells:
            return [_text(cell) for cell in cells]
    first = table.find("tr")
    if first is not None:
        cells = first.find_all(["th", "td"], recursive=False)
        if cells and all(cell.name == "th" for cell in cells):
            return [_text(cell) for cell in cells]
    return []


def _body_rows(table) -> list:
    """머리 줄을 뺀 표의 줄(tbody가 있으면 그 안, 없으면 th만 있는 줄을 뺀 모든 줄)."""
    bodies = table.find_all("tbody")
    if bodies:
        return [tr for body in bodies for tr in body.find_all("tr")]
    rows = table.find_all("tr")
    return [tr for tr in rows if not all(cell.name == "th" for cell in tr.find_all(["th", "td"], recursive=False))]


# ==============================================================================
# 목록
# ==============================================================================
def _list_table(soup):
    for table in soup.find_all("table"):
        header = {re.sub(r"\s", "", cell) for cell in _header(table)}
        if {"번호", "제목", "게시일"} <= header:
            return table
    raise ShapeError("목록 표(번호·제목·게시일)가 없음")


def _ntt_id(href: str) -> int | None:
    values = parse_qs(urlsplit(href).query).get("nttId") or []
    value = values[0].strip() if values else ""
    return int(value) if value.isdigit() else None


def parse_list(markup: str | bytes) -> list[ListItem]:
    """
    목록 한 쪽 → 글(쪽에 나온 순서, 같은 글은 한 번).

    :raises ShapeError: 목록 표가 없음, 줄에 글 번호·제목·게시일이 없음, 번호 칸이 숫자도 '공지'도 아님, 표에 줄이 하나도 없음
    """
    soup = BeautifulSoup(markup, "lxml")
    table = _list_table(soup)
    rows = _body_rows(table)
    if not rows:
        raise ShapeError("목록 표에 줄이 없음")
    found: dict[int, ListItem] = {}
    for tr in rows:
        cells = tr.find_all("td", recursive=False)
        if len(cells) <= 1:
            continue                        # 글이 없는 쪽의 안내 줄('게시물이 없습니다' 꼴)
        anchor = tr.find("a", href=True)
        ntt_id = _ntt_id(anchor["href"]) if anchor is not None else None
        if ntt_id is None:
            raise ShapeError("목록 줄에 글 번호(nttId)가 없음")
        title = _text(anchor)
        if not title:
            raise ShapeError("목록 줄에 제목이 없음")
        number_cell = tr.find("td", class_="num") or cells[0]
        date_cell = tr.find("td", class_="date") or cells[-1]
        number = _text(number_cell).replace(",", "")
        if number == "공지":
            pinned, list_no = True, None
        elif number.isdigit():
            pinned, list_no = False, int(number)
        else:
            raise ShapeError("목록 줄의 번호 칸이 숫자도 '공지'도 아님")
        item = ListItem(ntt_id, title, _date(_text(date_cell), "목록 줄의"), pinned, list_no, detail_url(ntt_id))
        before = found.get(ntt_id)
        if before is not None:
            item = ListItem(ntt_id, before.title, before.posted_on, before.pinned or item.pinned,
                            before.list_no if before.list_no is not None else item.list_no, before.url)
        found[ntt_id] = item
    return list(found.values())


# ==============================================================================
# 상세
# ==============================================================================
def _expand(rows, width: int) -> list[list[str]]:
    """줄 → 칸 글자 목록. 여러 줄로 묶인 칸(rowspan)은 아래 줄에 같은 글자를, 여러 칸으로 묶인 칸(colspan)은 옆 칸에 같은 글자를 채웁니다."""
    carry: dict[int, tuple[str, int]] = {}            # 칸 위치 → (글자, 남은 줄 수)
    out: list[list[str]] = []
    for tr in rows:
        cells = tr.find_all(["td", "th"], recursive=False)
        line: list[str] = []
        queue = list(cells)
        position = 0
        while queue or position in carry:
            if position in carry:
                text, left = carry[position]
                line.append(text)
                if left <= 1:
                    del carry[position]
                else:
                    carry[position] = (text, left - 1)
                position += 1
                continue
            cell = queue.pop(0)
            text = _text(cell)[:MAX_CELL_CHARS]
            span_rows = _span(cell.get("rowspan"))
            for _ in range(_span(cell.get("colspan"))):
                line.append(text)
                if span_rows > 1:
                    carry[position] = (text, span_rows - 1)
                position += 1
            if len(line) > width + 1:
                break
        out.append(line)
    return out


def _span(value) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return 1
    return min(max(number, 1), MAX_ROWS)


def parse_detail(markup: str | bytes) -> Detail:
    """
    글 한 건 → 제목·게시일·틀·4열 표의 행·제품명·'※' 문장·본문 글자.

    :raises ShapeError: 글 자리(제목·게시일·본문)가 없음, 4열 표의 줄 칸 수가 4가 아님·제품명이 빔, 4열 표에 줄이 없음
    """
    soup = BeautifulSoup(markup, "lxml")
    view = soup.select_one("section#View") or soup.select_one("#View")
    if view is None:
        raise ShapeError("상세 글 자리(#View)가 없음")
    heading = view.select_one(".b_title h2")
    stamp = view.select_one(".b_title span")
    content = view.select_one(".content_html")
    if heading is None or stamp is None or content is None:
        raise ShapeError("상세 글의 제목·게시일·본문 자리가 없음")
    title = _text(heading)
    if not title:
        raise ShapeError("상세 글의 제목이 빔")
    posted_on = _date(_text(stamp), "상세 글의")

    tables = content.find_all("table")
    rows: list[Row] = []
    product_tables = []
    for table in tables:
        if tuple(re.sub(r"\s", "", cell) for cell in _header(table)) != PRODUCT_HEADER:
            continue
        product_tables.append(table)
        lines = _expand(_body_rows(table), len(PRODUCT_HEADER))
        if not lines:
            raise ShapeError("버전 표에 줄이 없음")
        for cells in lines:
            if len(cells) != len(PRODUCT_HEADER):
                raise ShapeError(f"버전 표의 줄 칸 수가 {len(cells)}(4가 아님)")
            if not cells[1]:
                raise ShapeError("버전 표의 제품명 칸이 빔")
            rows.append(Row(*cells))
            if len(rows) > MAX_ROWS:
                raise ShapeError(f"버전 표의 줄이 {MAX_ROWS}을 넘음")
    layout = "product_table" if product_tables else ("other_table" if tables else "no_table")

    # 본문 글자는 4열 표만 뺀 것(다른 표의 글자는 남김 — 표가 없는 틀의 공지에서 제품 이름을 찾는 자리), '※' 문장은 표를 모두 뺀 글에서.
    for table in product_tables:
        table.decompose()
    text = html_to_text(str(content))
    for table in content.find_all("table"):
        table.decompose()
    notes: list[str] = []
    for line in html_to_text(str(content)).splitlines():
        line = line.strip()
        if line.startswith("※") and line not in notes:
            notes.append(line[:MAX_NOTE_CHARS])
    products: list[str] = []
    for row in rows:
        if row.product not in products:
            products.append(row.product)
    return Detail(title, posted_on, layout, tuple(rows), tuple(products), tuple(notes), text[:MAX_BODY_CHARS])
