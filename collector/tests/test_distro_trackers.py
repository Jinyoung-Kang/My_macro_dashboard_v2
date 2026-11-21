"""
tests/test_distro_trackers.py
배포판 보안 추적기 응답 읽기(ADR 0046 덧붙임 2026-11-21 '배포판 보안 추적기') — services/distro_trackers.

고정하는 규칙
  1. Ubuntu JSON: 원본 패키지·스위트의 상태 글 → released는 fixed(판 = description), not-affected·DNE는 not_affected, needed·pending·deferred·
     needs-triage·ignored는 open, 그 패키지·스위트가 없으면 unknown. 모르는 상태 글·판 칸 모양이 다르면 그 조회만 ShapeError.
  2. Debian HTML: 고친 판 표의 그 릴리스 줄(판·(not affected)·(unfixed))이 먼저, 없으면 같은 패키지의 (unstable) 줄이 그 릴리스에도 적용(판이면
     원본 패키지 표의 '스위트'·'스위트 (security)' 줄 — 쉼표로 묶인 Release 칸을 폄 — 에 fixed가 있을 때 그 판, 모두 vulnerable이면 open).
     고친 판 표에 그 패키지 줄이 없으면 원본 표의 판(지금 있는 판)을 쓰지 않음(fixed여도 unknown). 머리·표 틀이 다르면 ShapeError.
  3. Alpine secdb: secfixes 키 0 → not_affected, 그 밖의 키 → fixed(판 = 키), 항목의 첫 낱말이 CVE, main·community 순서, 없으면 unknown.
  4. 메시지(ShapeError)에 판 값이 없음.

응답은 모두 실제 응답의 틀만 흉내 낸 합성 자료입니다(지어낸 CVE 번호·판 번호·패키지 이름 — 공개 저장소, ADR 0046 결정 10).
"""
from __future__ import annotations

import json

import pytest

from app.services import distro_trackers as dt
from app.services.info_text import ShapeError

CVE = "CVE-2099-0001"


# ==============================================================================
# 합성 응답
# ==============================================================================
def _ubuntu(statuses: list[tuple[str, str, str]] | None = None, *, cve: str = CVE, package: str = "fakessl") -> bytes:
    """Ubuntu CVE JSON 틀 — statuses는 (스위트, 상태 글, description)."""
    statuses = statuses if statuses is not None else [
        ("fakecode", "released", "9.9.9-0fake1.1"), ("oldcode", "needed", ""), ("upstream", "released", "9.9.10"),
    ]
    return json.dumps({
        "id": cve, "description": "합성 설명", "priority": "medium", "status": "active",
        "packages": [
            {"name": "fakeother", "statuses": [{"release_codename": "fakecode", "status": "DNE", "description": "", "pocket": "security",
                                                "component": None}]},
            {"name": package, "source": "https://example.org/fake", "statuses": [
                {"release_codename": suite, "status": word, "description": text, "pocket": "security", "component": None}
                for suite, word, text in statuses]},
        ],
    }).encode("utf-8")


_DEBIAN_SOURCE_ROWS = """
<tr><td><a href="/tracker/source-package/fakessl">fakessl</a> (<a href="https://example.org/pkg/fakessl">PTS</a>)</td><td>olddeb</td>
    <td><span class="red">1.0-1</span></td><td><span class="red">vulnerable</span></td></tr>
<tr><td></td><td>olddeb (security)</td><td>1.0-1+deb1u1</td><td>fixed</td></tr>
<tr><td></td><td>fakedeb (security), fakedeb</td><td>2.0-1+deb2u1</td><td>fixed</td></tr>
<tr><td></td><td>nextdeb, sid</td><td>3.0-1</td><td>fixed</td></tr>
<tr><td><a href="/tracker/source-package/fakeweb">fakeweb</a> (<a href="https://example.org/pkg/fakeweb">PTS</a>)</td><td>fakedeb</td>
    <td><span class="red">5.0-1</span></td><td><span class="red">vulnerable</span></td></tr>
<tr><td></td><td>fakedeb (security)</td><td><span class="red">5.0-1+deb2u2</span></td><td><span class="red">vulnerable</span></td></tr>
<tr><td><a href="/tracker/source-package/fakelib">fakelib</a> (<a href="https://example.org/pkg/fakelib">PTS</a>)</td><td>fakedeb</td>
    <td>7.0-1</td><td>fixed</td></tr>
<tr><td></td><td>fakedeb (security)</td><td>7.0-1+deb2u1</td><td>fixed</td></tr>
<tr><td><a href="/tracker/source-package/fakeodd">fakeodd</a> (<a href="https://example.org/pkg/fakeodd">PTS</a>)</td><td>fakedeb</td>
    <td><span class="purple">8.0-1</span></td><td><span class="purple">undetermined</span></td></tr>
<tr><td><a href="/tracker/source-package/fakenew">fakenew</a> (<a href="https://example.org/pkg/fakenew">PTS</a>)</td><td>fakedeb</td>
    <td><span class="red">6.0-1</span></td><td><span class="red">vulnerable</span></td></tr>
<tr><td></td><td>sid</td><td>6.0-3</td><td>fixed</td></tr>
<tr><td><a href="/tracker/source-package/fakeplain">fakeplain</a> (<a href="https://example.org/pkg/fakeplain">PTS</a>)</td><td>fakedeb</td>
    <td><span class="red">9.0-1</span></td><td><span class="red">vulnerable</span></td></tr>
"""
_DEBIAN_FIXED_ROWS = """
<tr><td><a href="/tracker/source-package/fakessl">fakessl</a></td><td>source</td><td>olddeb</td><td>1.0-1+deb1u1</td><td></td>
    <td><a href="/tracker/DSA-0000-1">DSA-0000-1</a></td><td></td></tr>
<tr><td><a href="/tracker/source-package/fakessl">fakessl</a></td><td>source</td><td>(unstable)</td><td>2.0-1</td><td></td><td></td><td></td></tr>
<tr><td><a href="/tracker/source-package/fakenew">fakenew</a></td><td>source</td><td>(unstable)</td><td>6.0-2</td><td></td><td></td><td></td></tr>
<tr><td><a href="/tracker/source-package/fakenot">fakenot</a></td><td>source</td><td>(unstable)</td><td>(not affected)</td><td></td><td></td><td></td></tr>
<tr><td><a href="/tracker/source-package/fakexz">fakexz</a></td><td>source</td><td>fakedeb</td><td>(not affected)</td><td></td><td></td><td></td></tr>
<tr><td><a href="/tracker/source-package/fakexz">fakexz</a></td><td>source</td><td>(unstable)</td><td>4.0-1</td><td></td><td></td><td></td></tr>
<tr><td><a href="/tracker/source-package/fakeweb">fakeweb</a></td><td>source</td><td>(unstable)</td><td><span class="red">(unfixed)</span></td>
    <td>unimportant</td><td></td><td></td></tr>
<tr><td><a href="/tracker/source-package/fakekern">fakekern</a></td><td>source</td><td>fakedeb</td><td><span class="red">(unfixed)</span></td>
    <td></td><td></td><td></td></tr>
"""


def _debian(*, cve: str = CVE, source_rows: str = _DEBIAN_SOURCE_ROWS, fixed_rows: str = _DEBIAN_FIXED_ROWS,
            source_header: str = "<th>Source Package</th><th>Release</th><th>Version</th><th>Status</th>",
            notes: bool = True) -> bytes:
    """Debian 보안 추적기 CVE 쪽의 틀 — 머리 표, '취약·고친 패키지' 절의 원본 패키지 표, 고친 판 표."""
    tables = "" if not notes else f"""<h2>Vulnerable and fixed packages</h2><p>The table below lists information on source packages.</p>
<table><tr>{source_header}</tr>{source_rows}</table>
<p>The information below is based on the following data on fixed versions.</p><table>
<tr><th>Package</th><th>Type</th><th>Release</th><th>Fixed Version</th><th>Urgency</th><th>Origin</th><th>Debian Bugs</th></tr>{fixed_rows}</table>"""
    return f"""<!DOCTYPE html><html><head><title>{cve}</title></head><body><header><h1>{cve}</h1></header><table>
<tr><td><b>Name</b></td><td>{cve}</td></tr><tr><td><b>Description</b></td><td>합성 설명</td></tr></table>{tables}
<h2>Notes</h2><pre>합성 메모</pre><hr/><footer><p>합성 바닥글</p></footer></body></html>""".encode("utf-8")


def _alpine(packages: dict[str, dict[str, list[str]]], *, suite: str = "v9.99", repo: str = "main") -> bytes:
    """Alpine secdb JSON 틀 — packages는 원본 패키지 → {판 키: [CVE …]}."""
    return json.dumps({
        "apkurl": "{{urlprefix}}/{{distroversion}}/{{reponame}}/{{arch}}/{{pkg.name}}-{{pkg.ver}}.apk",
        "archs": ["x86_64"], "reponame": repo, "urlprefix": "https://example.org/alpine", "distroversion": suite,
        "packages": [{"pkg": {"name": name, "secfixes": fixes}} for name, fixes in packages.items()],
    }).encode("utf-8")


# ==============================================================================
# 주소
# ==============================================================================
def test_주소는_추적기마다_정해진_꼴이고_모양이_다른_값은_받지_않는다():
    assert dt.ubuntu_url(CVE) == "https://ubuntu.com/security/cves/CVE-2099-0001.json"
    assert dt.debian_url("CVE-2099-1234567") == "https://security-tracker.debian.org/tracker/CVE-2099-1234567"
    assert dt.alpine_url("v9.99", "community") == "https://secdb.alpinelinux.org/v9.99/community.json"
    for bad in ("CVE-2099-1", "cve-2099-0001", "CVE-2099-0001/../x"):
        with pytest.raises(ValueError):
            dt.ubuntu_url(bad)
    with pytest.raises(ValueError):
        dt.alpine_url("9.99", "main")
    with pytest.raises(ValueError):
        dt.alpine_url("v9.99", "testing")


# ==============================================================================
# Ubuntu
# ==============================================================================
@pytest.mark.parametrize("word, text, status, fixed", [
    ("released", "9.9.9-0fake1.1", "fixed", "9.9.9-0fake1.1"),
    ("released", "1:9.9.9-0fake1~esm1", "fixed", "1:9.9.9-0fake1~esm1"),
    ("not-affected", "9.9.0-1", "not_affected", None),
    ("DNE", "", "not_affected", None),
    ("needed", "", "open", None),
    ("pending", "9.9.9-0fake2", "open", None),
    ("deferred", "", "open", None),
    ("needs-triage", "", "open", None),
    ("ignored", "end of standard support", "open", None),
])
def test_Ubuntu_상태_글을_넷으로_옮긴다(word, text, status, fixed):
    index = dt.parse_ubuntu(_ubuntu([("fakecode", word, text)]), CVE)

    result = dt.ubuntu_status(index, "fakessl", "fakecode")

    assert (result.status, result.fixed_version) == (status, fixed)
    assert result.detail.startswith(word) and len(result.detail) <= dt.MAX_DETAIL_CHARS


def test_Ubuntu_그_패키지나_스위트가_없으면_unknown():
    index = dt.parse_ubuntu(_ubuntu(), CVE)
    assert dt.ubuntu_status(index, "fakessl", "nosuchcode").status == "unknown"
    assert dt.ubuntu_status(index, "nosuchpkg", "fakecode").status == "unknown"
    assert dt.ubuntu_status(index, "fakeother", "fakecode").status == "not_affected", "다른 패키지 항목은 그 패키지만"
    assert dt.ubuntu_status(dt.parse_ubuntu(_ubuntu([]), CVE), "fakessl", "fakecode").status == "unknown"


@pytest.mark.parametrize("word, text", [("mystery", ""), ("released", ""), ("released", "9.9.9 and 9.9.10")])
def test_Ubuntu_모르는_상태_글이나_판_칸_모양이_다르면_그_조회만_ShapeError(word, text):
    index = dt.parse_ubuntu(_ubuntu([("fakecode", word, text), ("oldcode", "needed", "")]), CVE)
    with pytest.raises(ShapeError) as caught:
        dt.ubuntu_status(index, "fakessl", "fakecode")
    assert "9.9.9" not in str(caught.value), "메시지에 판 값 없음"
    assert dt.ubuntu_status(index, "fakessl", "oldcode").status == "open"


@pytest.mark.parametrize("body", [
    b"<html>not json</html>",
    _ubuntu(cve="CVE-2099-0002"),
    json.dumps({"id": CVE}).encode(),
    json.dumps({"id": CVE, "packages": [{"name": "fakessl"}]}).encode(),
    json.dumps({"id": CVE, "packages": [{"name": "fakessl", "statuses": [{"status": "released"}]}]}).encode(),
    json.dumps([CVE]).encode(),
])
def test_Ubuntu_틀이_다르면_ShapeError(body):
    with pytest.raises(ShapeError):
        dt.parse_ubuntu(body, CVE)


# ==============================================================================
# Debian
# ==============================================================================
@pytest.mark.parametrize("package, suite, status, fixed, detail", [
    ("fakessl", "olddeb", "fixed", "1.0-1+deb1u1", "fixed"),                        # 고친 판 표의 그 릴리스 줄
    ("fakexz", "fakedeb", "not_affected", None, "(not affected)"),
    ("fakekern", "fakedeb", "open", None, "(unfixed)"),
    ("fakessl", "fakedeb", "fixed", "2.0-1", "fixed (unstable)"),                   # 릴리스 줄 없음 → (unstable)의 판, 원본 표(묶인 Release 칸)는 fixed
    ("fakessl", "nextdeb", "fixed", "2.0-1", "fixed (unstable)"),
    ("fakenew", "fakedeb", "open", None, "fakedeb: vulnerable"),                     # (unstable)은 고쳤지만 그 릴리스는 아직 vulnerable
    ("fakenew", "sid", "fixed", "6.0-2", "fixed (unstable)"),
    ("fakenot", "fakedeb", "not_affected", None, "(not affected) (unstable)"),
    ("fakeweb", "fakedeb", "open", None, "(unfixed) (unstable)"),
    ("fakelib", "fakedeb", "unknown", None, "fixed; no fixed-version row"),          # 고친 판 표에 그 패키지 줄이 없으면 원본 표의 판을 쓰지 않음
    ("fakeplain", "fakedeb", "open", None, "fakedeb: vulnerable"),
    ("fakeodd", "fakedeb", "unknown", None, "fakedeb: undetermined"),
    ("fakessl", "nosuchdeb", "unknown", None, "no entry"),
    ("nosuchpkg", "fakedeb", "unknown", None, "no entry"),
])
def test_Debian_릴리스_줄이_먼저이고_없으면_unstable_줄이_그_릴리스에도_적용(package, suite, status, fixed, detail):
    record = dt.parse_debian(_debian(), CVE)

    result = dt.debian_status(record, package, suite)

    assert (result.status, result.fixed_version, result.detail) == (status, fixed, detail)


def test_Debian_원본_표의_지금_판을_고친_판으로_쓰지_않는다():
    """재현: 고친 판 표에 그 릴리스 줄이 없을 때 원본 표의 판(그 스위트에 지금 있는 판)을 고친 판으로 쓰면, 고친 판(unstable 2.0-1)보다 높고
    지금 판보다 낮은 옛 이미지(예: 2.0-1+deb2u1)가 '뒤처짐'(해당)으로 잘못 알려졌습니다."""
    rows = """<tr><td><a href="/tracker/source-package/fakessl">fakessl</a></td><td>fakedeb (security), fakedeb</td><td>2.0-1+deb2u5</td>
        <td>fixed</td></tr><tr><td></td><td>sid</td><td>3.0-1</td><td>fixed</td></tr>"""
    unstable = """<tr><td><a href="/tracker/source-package/fakessl">fakessl</a></td><td>source</td><td>(unstable)</td><td>2.0-1</td>
        <td></td><td></td><td></td></tr>"""

    result = dt.debian_status(dt.parse_debian(_debian(source_rows=rows, fixed_rows=unstable), CVE), "fakessl", "fakedeb")
    assert (result.status, result.fixed_version) == ("fixed", "2.0-1"), "그 릴리스에 적용되는 (unstable)의 고친 판"

    result = dt.debian_status(dt.parse_debian(_debian(source_rows=rows, fixed_rows=""), CVE), "fakessl", "fakedeb")
    assert (result.status, result.fixed_version, result.detail) == ("unknown", None, "fixed; no fixed-version row"), \
        "고친 판 표에 그 패키지 줄이 없으면 판을 정하지 않음"


def test_Debian_패키지_기록이_없는_CVE는_모두_unknown():
    record = dt.parse_debian(_debian(notes=False), CVE)
    assert record.sources == {} and record.fixed == []
    assert dt.debian_status(record, "fakessl", "fakedeb").status == "unknown"


@pytest.mark.parametrize("body, why", [
    (_debian(cve="CVE-2099-0002"), "머리"),
    (_debian(source_header="<th>Package</th><th>Release</th><th>Version</th><th>Status</th>"), "두 표"),
    (_debian(source_rows='<tr><td></td><td>fakedeb</td><td>1</td><td>fixed</td></tr>'), "원본 이름"),
    (_debian(source_rows='<tr><td>fakessl</td><td>fakedeb</td><td>fixed</td></tr>'), "칸 수"),
    (_debian(fixed_rows='<tr><td>fakessl</td><td>source</td><td>fakedeb</td></tr>'), "칸 수"),
    (b"<html><body><h1>CVE-2099-0001</h1><h2>Vulnerable and fixed packages</h2><p>moved</p></body></html>", "표가 없음"),
    (b"<html><body><h2>Vulnerable and fixed packages</h2></body></html>", "머리"),
])
def test_Debian_틀이_다르면_ShapeError(body, why):
    with pytest.raises(ShapeError, match=why):
        dt.parse_debian(body, CVE)


def test_Debian_원본_표에_모르는_상태_글이면_그_조회만_ShapeError():
    rows = _DEBIAN_SOURCE_ROWS.replace("<td><span class=\"purple\">undetermined</span></td>", "<td>mystery</td>")
    record = dt.parse_debian(_debian(source_rows=rows), CVE)
    with pytest.raises(ShapeError):
        dt.debian_status(record, "fakeodd", "fakedeb")
    assert dt.debian_status(record, "fakeweb", "fakedeb").status == "open"


# ==============================================================================
# Alpine
# ==============================================================================
MAIN = {
    "fakessl": {"0": ["CVE-2099-0002"], "9.9.9-r1": ["CVE-2099-0001", "CVE-2099-0003 FAKE-SA-2099-01"], "9.9.10-r0": ["CVE-2099-0001"]},
    "fakezip": {"1.0-r1": ["CVE-2099-0004"]},
    "fakeempty": {},
}
COMMUNITY = {"fakeweb": {"5.0-r2": ["CVE-2099-0001"]}}


@pytest.mark.parametrize("package, cve, status, fixed, detail", [
    ("fakessl", "CVE-2099-0002", "not_affected", None, "secfixes 0 (main)"),
    ("fakessl", "CVE-2099-0001", "fixed", "9.9.9-r1", "secfixes (main)"),            # 키가 여럿이면 문서 순서의 처음
    ("fakessl", "CVE-2099-0003", "fixed", "9.9.9-r1", "secfixes (main)"),            # 'CVE-… 다른 번호' 꼴
    ("fakeweb", "CVE-2099-0001", "fixed", "5.0-r2", "secfixes (community)"),
    ("fakessl", "CVE-2099-0009", "unknown", None, "no cve entry"),
    ("fakeempty", "CVE-2099-0001", "unknown", None, "no cve entry"),
    ("nosuchpkg", "CVE-2099-0001", "unknown", None, "no package entry"),
])
def test_Alpine_secfixes_키로_고친_판과_영향_없음을_가린다(package, cve, status, fixed, detail):
    indexes = [dt.parse_alpine(_alpine(MAIN), "v9.99", "main"), dt.parse_alpine(_alpine(COMMUNITY, repo="community"), "v9.99", "community")]

    result = dt.alpine_status(indexes, package, cve, dt.ALPINE_REPOS)

    assert (result.status, result.fixed_version, result.detail) == (status, fixed, detail)


def test_Alpine_고친_판_키_모양이_다르면_그_조회만_ShapeError():
    index = dt.parse_alpine(_alpine({"fakessl": {"9.9 beta": ["CVE-2099-0001"]}, "fakezip": {"1.0-r1": ["CVE-2099-0004"]}}), "v9.99", "main")
    with pytest.raises(ShapeError) as caught:
        dt.alpine_status([index, {}], "fakessl", "CVE-2099-0001", dt.ALPINE_REPOS)
    assert "9.9" not in str(caught.value)
    assert dt.alpine_status([index, {}], "fakezip", "CVE-2099-0004", dt.ALPINE_REPOS).status == "fixed"


@pytest.mark.parametrize("body", [
    b"not json",
    _alpine(MAIN, suite="v9.98"),
    _alpine(MAIN, repo="community"),
    json.dumps({"distroversion": "v9.99", "reponame": "main"}).encode(),
    json.dumps({"distroversion": "v9.99", "reponame": "main", "packages": [{"pkg": {"secfixes": {}}}]}).encode(),
    json.dumps({"distroversion": "v9.99", "reponame": "main", "packages": [{"pkg": {"name": "x", "secfixes": {"1-r0": "CVE-2099-0001"}}}]}).encode(),
])
def test_Alpine_틀이_다르면_ShapeError(body):
    with pytest.raises(ShapeError):
        dt.parse_alpine(body, "v9.99", "main")
