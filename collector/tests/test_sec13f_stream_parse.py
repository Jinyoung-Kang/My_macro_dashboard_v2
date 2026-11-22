"""
tests/test_sec13f_stream_parse.py
13F 보유 표(information table) XML 읽기를 통째 파싱(ET.fromstring)에서 스트리밍(ET.iterparse — infoTable 하나씩 읽고 비움)으로 바꿔도
결과가 같은지(2026-11-23 — 수집기 메모리, QA-989 뒤 후속). 바꾸기 전 함수를 그대로 옮긴 기준 구현과 여러 모양의 XML로 대조합니다.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest

from app.services import sec13f
from app.services.sec13f import _to_float

NS = "http://www.sec.gov/edgar/document/thirteenf/informationtable"


def _reference(content: bytes, filing_date: str) -> list[dict]:
    """바꾸기 전 sec13f._parse_information_table 그대로(통째 파싱)."""
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return []
    merged: dict[tuple[str, str, str], dict] = {}
    for node in root.iter():
        if not node.tag.lower().endswith("infotable"):
            continue
        name = cusip = title_class = put_call = amount_type = ""
        value = shares = 0.0
        for child in node.iter():
            tag = child.tag.lower()
            text = (child.text or "").strip()
            if tag.endswith("nameofissuer"):
                name = text
            elif tag.endswith("titleofclass"):
                title_class = text
            elif tag.endswith("cusip"):
                cusip = text
            elif tag.endswith("value"):
                value = _to_float(text)
            elif tag.endswith("sshprnamt"):
                shares = _to_float(text)
            elif tag.endswith("sshprnamttype"):
                amount_type = text.upper()
            elif tag.endswith("putcall"):
                put_call = text
        if not name or value <= 0:
            continue
        if put_call:
            continue
        key = (name.strip().upper(), cusip.strip(), title_class.strip())
        entry = merged.setdefault(key, {"name": key[0], "cusip": key[1], "class": key[2], "value": 0.0, "shares": 0.0, "weight": 0.0})
        entry["value"] += value
        if amount_type == "PRN" or entry["shares"] is None:
            entry["shares"] = None
        else:
            entry["shares"] += shares
    return list(merged.values())


def _row(name, cusip, cls, value, shares, kind="SH", put_call=None, prefix="ns1:"):
    p = prefix
    pc = f"<{p}putCall>{put_call}</{p}putCall>" if put_call else ""
    return (f"<{p}infoTable><{p}nameOfIssuer>{name}</{p}nameOfIssuer><{p}titleOfClass>{cls}</{p}titleOfClass>"
            f"<{p}cusip>{cusip}</{p}cusip><{p}value>{value}</{p}value>"
            f"<{p}shrsOrPrnAmt><{p}sshPrnamt>{shares}</{p}sshPrnamt><{p}sshPrnamtType>{kind}</{p}sshPrnamtType></{p}shrsOrPrnAmt>"
            f"{pc}<{p}investmentDiscretion>SOLE</{p}investmentDiscretion>"
            f"<{p}votingAuthority><{p}Sole>{shares}</{p}Sole><{p}Shared>0</{p}Shared><{p}None>0</{p}None></{p}votingAuthority></{p}infoTable>")


def _doc(rows: list[str], prefix="ns1:") -> bytes:
    if prefix:
        head = f'<?xml version="1.0" encoding="UTF-8"?><{prefix}informationTable xmlns:{prefix[:-1]}="{NS}">'
        tail = f"</{prefix}informationTable>"
    else:
        head = f'<?xml version="1.0" encoding="UTF-8"?><informationTable xmlns="{NS}">'
        tail = "</informationTable>"
    return (head + "".join(rows) + tail).encode()


CASES = {
    "이름공간 접두사": _doc([_row("APPLE INC", "037833100", "COM", 1000, 10), _row("NVIDIA CORP", "67066G104", "COM", 500, 5)]),
    "기본 이름공간(접두사 없음)": _doc([_row("APPLE INC", "037833100", "COM", 1000, 10, prefix="")], prefix=""),
    "같은 증권 두 줄 합침·대소문자": _doc([_row("Apple Inc", "037833100", "COM", 1000, 10), _row("APPLE INC", "037833100", "COM", 250, 3)]),
    "옵션 줄 빼기": _doc([_row("APPLE INC", "037833100", "COM", 1000, 10), _row("APPLE INC", "037833100", "COM", 900, 9, put_call="Put")]),
    "PRN은 주식 수 모름": _doc([_row("FAKE BOND", "999999999", "NOTE 1.0% 2030", 300, 300000, kind="PRN"),
                                 _row("FAKE BOND", "999999999", "NOTE 1.0% 2030", 200, 200000)]),
    "0·빈 이름 줄 빼기": _doc([_row("", "000000001", "COM", 10, 1), _row("ZERO CO", "000000002", "COM", 0, 1),
                               _row("REAL CO", "000000003", "COM", 7, 1)]),
    "앞 0 CUSIP·특수 글자": _doc([_row("AT&amp;T INC", "00206R102", "COM", 42, 4)]),
    "보유 없음": _doc([]),
    "깨진 XML": b"<informationTable><infoTable><nameOfIssuer>X</nameOfIssuer>",
    "XML 아님": b"not xml at all",
}


@pytest.mark.parametrize("name", list(CASES))
def test_스트리밍_파싱은_통째_파싱과_결과가_같다(name):
    content = CASES[name]
    assert sec13f._parse_information_table(content, "2026-08-14") == _reference(content, "2026-08-14")


def test_큰_보유_표도_같고_차례도_같다():
    rows = [_row(f"FAKE CO {i}", f"{i:09d}", "COM" if i % 3 else "CL A", 1000 + i, 10 + i, kind="PRN" if i % 97 == 0 else "SH")
            for i in range(5000)]
    rows += [_row("FAKE CO 7", f"{7:09d}", "COM", 5, 1)]       # 앞 줄과 같은 증권 — 합침
    content = _doc(rows)
    out = sec13f._parse_information_table(content, "2026-08-14")
    assert out == _reference(content, "2026-08-14")
    assert len(out) == 5000
