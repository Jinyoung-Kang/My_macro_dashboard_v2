"""
tests/test_kisa_notices.py
보안 공지(ADR 0046) — 보호나라 보안공지 목록·상세 HTML 읽기(services/kisa_notices). 네트워크·DB 없음.

고정본은 보호나라 게시판의 **구조만 흉내 낸 합성 HTML**입니다(ADR 0046 결정 10 — 글 본문·표를 공개 저장소에 옮기지 않음). 제품 이름·버전·
CVE 번호는 모두 가짜입니다.

고정하는 규칙
  1. 목록: 게시판 표(번호·제목·게시일)의 줄마다 nttId·제목·게시일·번호 칸. 번호 칸 '공지'는 고정 공지(번호 없음). 같은 쪽에 같은 글이 둘이면
     한 건(고정 여부와 번호를 합침). 주소는 검색어·쪽 번호 없는 상세 주소. 글이 없는 쪽(칸 하나짜리 안내 줄)은 빈 목록.
  2. 상세: 틀은 4열 표(취약점·제품명·영향받는 버전·해결 버전 — 머리 칸의 빈칸은 무시)가 있으면 product_table, 다른 표만 있으면 other_table,
     표가 없으면 no_table. 4열 표의 칸은 원문 그대로(버전 해석 없음), rowspan은 아래 줄에 채움. 제품명은 처음 나온 순서의 고유 값.
     '※' 문장은 표 밖의 '※'로 시작하는 줄만. 본문 글자는 4열 표만 뺀 것.
  3. 틀이 깨지면 info_text.ShapeError — 목록 표 없음·글 번호 없음·번호 칸이 이상함·게시일 모양이 다름, 상세 글 자리 없음·4열 표 줄 칸 수가 다름.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.services import kisa_notices as kisa
from app.services.info_text import ShapeError


def _list_page(rows: str, *, header: str = "<th>번호</th><th>제목</th><th>조회수</th><th>첨부</th><th>게시일</th>") -> str:
    return f"""<!doctype html><html><head><title>합성 목록</title></head><body>
    <form id="frm"><input type="hidden" name="pageIndex" value="1"></form>
    <div class="bbs_list"><table><caption>게시판 목록</caption>
      <thead><tr>{header}</tr></thead>
      <tbody>{rows}</tbody>
    </table></div>
    <div class="pagination"><ul><li class="current"><a>1</a></li><li><a href="?pageIndex=2">2</a></li></ul></div>
    </body></html>"""


def _row(number: str, ntt_id: int, title: str, posted: str) -> str:
    href = (f"/kr/bbs/view.do?searchCnd=&amp;bbsId=B0000133&amp;searchWrd=&amp;menuNo=205020&amp;pageIndex=1"
            f"&amp;categoryCode=&amp;nttId={ntt_id}")
    return f"""<tr><td class="num">{number}</td>
      <td class="sbj tal"><a href="{href}">
          {title}
      </a></td>
      <td class="count xs-hidden">1,234</td><td class="attach xs-hidden"></td>
      <td class="date">{posted}</td></tr>"""


def _detail(content: str, *, title: str = "합성 제품 보안 업데이트 권고", posted: str = "2026-11-10") -> str:
    return f"""<!doctype html><html><body><div id="container">
    <section id="View" class="bbs"><div class="board">
      <header><div class="b_title"><h2>{title}</h2><span>{posted}</span></div></header>
      <div class="content"><div class="content_html">{content}</div></div>
      <ul class="lnHref"><li>이전 글</li></ul>
    </div><div class="btnsWrap"><a href="#">목록</a></div></section>
    </div></body></html>"""


PRODUCT_TABLE = """<div class="s-table-container"><table class="s-table">
  <thead><tr><th>취약점</th><th>제품명</th><th>영향받는 버전</th><th>해결 버전</th></tr></thead>
  <tbody>
   <tr><td>CVE-2099-0001</td><td>ExampleDB</td><td>9 이상 9.4 미만</td><td>9.4 이상</td></tr>
   <tr><td>CVE-2099-0001</td><td>ExampleDB</td><td>8 이상 8.9 미만</td><td>8.9 이상</td></tr>
   <tr><td>CVE-2099-0002</td><td>ExampleDB Tools</td><td>1.2.3</td><td>-</td></tr>
  </tbody></table></div>"""

PRODUCT_BODY = f"""<div class="stacks-scope"><div class="s-prose">
  <p>□ 개요 <br> <span> </span>o 합성 재단은 자사 제품의 취약점을 해결한 업데이트 발표 [1] <br></p>
  <p>□ 설명 <br> <span> </span>o ExampleDB에서 발생하는 합성 취약점(CVE-2099-0001) [1][2] <br></p>
  <p>□ 영향을 받는 제품 및 해결 방안</p>
  {PRODUCT_TABLE}
  <p>※ 합성 계열 7 이하는 지원이 끝나 지원 중인 버전으로 전환 권고 [1] <br> <span> </span>※ 하단의 참고 사이트를 확인하여 업데이트 수행 [1] <br></p>
  <p>□ 참고사이트 <br> <span> </span>[1] <a href="https://example.org/advisory">https://example.org/advisory</a> <br></p>
  <p>o 문장 가운데의 ※ 표시는 조건 문장이 아님</p>
</div></div>"""


# ==============================================================================
# 1. 목록
# ==============================================================================
def test_목록은_고정_공지와_번호_줄을_읽고_상세_주소를_정규화한다():
    page = _list_page(
        _row("공지", 900010, "합성 고정 공지", "2026-03-02")
        + _row("2645", 900100, "합성 제품 보안 업데이트 권고", "2026-11-20")
        + _row("2,644", 900099, "다른 합성 제품 보안 업데이트 권고", "2026-11-19"))

    items = kisa.parse_list(page)

    assert items == [
        kisa.ListItem(900010, "합성 고정 공지", date(2026, 3, 2), True, None, kisa.detail_url(900010)),
        kisa.ListItem(900100, "합성 제품 보안 업데이트 권고", date(2026, 11, 20), False, 2645, kisa.detail_url(900100)),
        kisa.ListItem(900099, "다른 합성 제품 보안 업데이트 권고", date(2026, 11, 19), False, 2644, kisa.detail_url(900099)),
    ]
    assert kisa.detail_url(900100) == "https://www.boho.or.kr/kr/bbs/view.do?menuNo=205020&bbsId=B0000133&nttId=900100"
    assert kisa.list_url(3) == "https://www.boho.or.kr/kr/bbs/list.do?menuNo=205020&bbsId=B0000133&pageIndex=3"


def test_같은_쪽에_고정_공지와_번호_줄로_함께_나온_글은_한_건():
    page = _list_page(_row("공지", 900050, "합성 공지", "2026-11-01") + _row("2600", 900050, "합성 공지", "2026-11-01"))

    assert kisa.parse_list(page) == [kisa.ListItem(900050, "합성 공지", date(2026, 11, 1), True, 2600, kisa.detail_url(900050))]


def test_글이_없는_쪽은_빈_목록():
    assert kisa.parse_list(_list_page('<tr><td colspan="5">게시물이 없습니다.</td></tr>')) == []


@pytest.mark.parametrize("page, why", [
    ("<html><body><p>점검 중</p></body></html>", "목록 표"),
    (_list_page(_row("1", 1, "x", "2026-11-01"), header="<th>순서</th><th>글</th><th>날짜</th>"), "목록 표"),
    (_list_page(""), "줄이 없음"),
    (_list_page(_row("12", 5, "합성", "2026-11-01").replace("nttId=5", "nttId=")), "nttId"),
    (_list_page(_row("알림", 5, "합성", "2026-11-01")), "번호 칸"),
    (_list_page(_row("12", 5, "합성", "2026.11.01")), "게시일"),
    (_list_page(_row("12", 5, "합성", "2026-02-30")), "게시일"),
    (_list_page(_row("12", 5, "  ", "2026-11-01")), "제목"),
])
def test_목록_틀이_깨지면_ShapeError(page, why):
    with pytest.raises(ShapeError, match=why):
        kisa.parse_list(page)


# ==============================================================================
# 2. 상세
# ==============================================================================
def test_4열_표의_공지는_행을_원문_그대로_읽고_제품명_조건_문장_본문을_고른다():
    detail = kisa.parse_detail(_detail(PRODUCT_BODY))

    assert detail.title == "합성 제품 보안 업데이트 권고" and detail.posted_on == date(2026, 11, 10)
    assert detail.layout == "product_table"
    assert detail.rows == (
        kisa.Row("CVE-2099-0001", "ExampleDB", "9 이상 9.4 미만", "9.4 이상"),
        kisa.Row("CVE-2099-0001", "ExampleDB", "8 이상 8.9 미만", "8.9 이상"),
        kisa.Row("CVE-2099-0002", "ExampleDB Tools", "1.2.3", "-"),
    )
    assert detail.products == ("ExampleDB", "ExampleDB Tools")
    assert detail.notes == ("※ 합성 계열 7 이하는 지원이 끝나 지원 중인 버전으로 전환 권고 [1]",
                            "※ 하단의 참고 사이트를 확인하여 업데이트 수행 [1]")
    assert "□ 설명" in detail.body_text and "o ExampleDB에서 발생하는 합성 취약점(CVE-2099-0001) [1][2]" in detail.body_text
    assert "9.4 미만" not in detail.body_text, "4열 표는 본문 글자에서 뺌(행으로 따로 둠)"
    assert "이전 글" not in detail.body_text and "목록" not in detail.body_text, "본문 자리 밖은 읽지 않음"


def test_여러_줄로_묶인_칸은_아래_줄에_같은_글자를_채운다():
    table = """<table class="s-table"><thead><tr><th>취약점</th><th>제품명</th><th>영향받는 버전</th><th>해결 버전</th></tr></thead>
      <tbody>
        <tr><td rowspan="3">CVE-2099-0100</td><td rowspan="2">ExampleWeb</td><td>2.0 이상 2.3 미만</td><td>2.3 이상</td></tr>
        <tr><td>1.0 이상 1.9 미만</td><td>1.9 이상</td></tr>
        <tr><td>ExampleWeb Plus</td><td colspan="2">모든 버전</td></tr>
      </tbody></table>"""

    detail = kisa.parse_detail(_detail(table))

    assert detail.rows == (
        kisa.Row("CVE-2099-0100", "ExampleWeb", "2.0 이상 2.3 미만", "2.3 이상"),
        kisa.Row("CVE-2099-0100", "ExampleWeb", "1.0 이상 1.9 미만", "1.9 이상"),
        kisa.Row("CVE-2099-0100", "ExampleWeb Plus", "모든 버전", "모든 버전"),
    )


def test_머리_칸의_빈칸이_달라도_thead가_없어도_4열_표로_읽는다():
    table = """<table><tr><th>취약점</th><th>제품 명</th><th>영향 받는 버전</th><th>해결버전</th></tr>
      <tr><td>CVE-2099-0200</td><td>ExampleCache</td><td>3.1.0 이하</td><td>3.1.1</td></tr></table>"""

    detail = kisa.parse_detail(_detail(table))

    assert detail.layout == "product_table"
    assert detail.rows == (kisa.Row("CVE-2099-0200", "ExampleCache", "3.1.0 이하", "3.1.1"),)


def test_다른_표만_있는_공지는_other_table이고_그_표의_글자는_본문에_남는다():
    content = """<h3>□ 개요</h3><ul><li>합성 보안강화 권고</li></ul>
      <table><thead><tr><th>구분</th><th>점검사항</th></tr></thead>
      <tbody><tr><td>① 외부 노출</td><td>ExampleDB 관리 화면 접근 제한 ※ 표 안의 표시</td></tr></tbody></table>
      <p>※ 합성 조건 문장</p>"""

    detail = kisa.parse_detail(_detail(content, title="합성 보안강화 권고"))

    assert detail.layout == "other_table" and detail.rows == () and detail.products == ()
    assert "ExampleDB 관리 화면 접근 제한" in detail.body_text
    assert detail.notes == ("※ 합성 조건 문장",), "표 안의 ※는 조건 문장이 아님"


def test_표가_없는_공지는_no_table():
    detail = kisa.parse_detail(_detail("<p>□ 개요<br>o 합성 악성코드 유포 주의</p>"))

    assert detail.layout == "no_table" and detail.rows == () and detail.notes == ()
    assert detail.body_text == "□ 개요\no 합성 악성코드 유포 주의"


@pytest.mark.parametrize("page, why", [
    ("<html><body><p>점검 중</p></body></html>", "#View"),
    (_detail(PRODUCT_BODY).replace('<div class="content_html">', '<div class="content_other">'), "본문 자리"),
    (_detail(PRODUCT_BODY, posted="11월 10일"), "게시일"),
    (_detail(PRODUCT_BODY).replace("<td>1.2.3</td>", ""), "칸 수가 3"),
    (_detail(PRODUCT_BODY).replace("<td>ExampleDB Tools</td>", "<td> </td>"), "제품명"),
    (_detail(PRODUCT_TABLE.split("<tbody>")[0] + "<tbody></tbody></table></div>"), "줄이 없음"),
])
def test_상세_틀이_깨지면_ShapeError(page, why):
    with pytest.raises(ShapeError, match=why):
        kisa.parse_detail(page)
