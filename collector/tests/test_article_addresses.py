"""
tests/test_article_addresses.py
기사 한 건 받기의 주소 검사(ADR 0043 — app/fetch/addresses). 네트워크 없이 — 이름 풀기는 자리 바꿔 끼우기만.

고정하는 규칙
  1. 공인 주소만 지나감: 사설·루프백·링크 로컬(169.254 — 클라우드 메타데이터)·CGNAT 100.64/10(Tailscale)·멀티캐스트·예약·미지정·IPv6 ::1·ULA fc00::/7
     (Tailscale fd7a:115c:a1e0::/48)·fe80::/10·IPv4를 감싼 IPv6·6to4·Teredo·NAT64는 막음.
  2. 브라우저 컨테이너 문지기(sidecar/guard.is_global_address)와 같은 판정 — 공통 표는 같은 답, 터널 대역은 수집기가 더 엄격한 쪽(문지기가 막는 것을
     수집기가 통과시키지 않음).
  3. 보내기 전에 막음: http·https 밖의 scheme, 80·443 밖의 포트, 사용자 정보, IP 글자 호스트(변형 포함), 한 낱말 호스트(compose 서비스 이름),
     내부 이름 끝, 2,048자 넘는 주소. 조각은 떼고 국제화 도메인은 punycode로.
  4. 이름이 하나라도 내부 주소로 풀리면 막음, 풀리지 않으면 unresolved. 고정 주소 줄은 첫 IPv4(없으면 IPv6 대괄호).
"""
from __future__ import annotations

import pytest

from app.fetch import addresses
from sidecar import guard

REFUSED = [
    "10.0.0.5", "172.16.3.4", "192.168.1.10", "127.0.0.1", "169.254.169.254", "100.64.0.1", "100.100.100.100", "224.0.0.1",
    "240.0.0.1", "0.0.0.0", "255.255.255.255", "198.18.0.1", "192.0.2.10",
    "::1", "::", "fc00::1", "fd7a:115c:a1e0::1", "fe80::1", "fec0::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
    "not-an-ip", "",
]
ALLOWED = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]
TUNNELS = ["2002:a00:1::1", "2002:808:808::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b::a00:1", "64:ff9b::808:808",
           "64:ff9b:1::1"]


@pytest.mark.parametrize("address", REFUSED)
def test_공인_주소가_아니면_막는다(address):
    assert addresses.is_global_address(address) is False


@pytest.mark.parametrize("address", ALLOWED)
def test_공인_주소는_지나간다(address):
    assert addresses.is_global_address(address) is True


@pytest.mark.parametrize("address", TUNNELS)
def test_터널_대역은_안에_든_주소와_상관없이_막는다(address):
    assert addresses.is_global_address(address) is False


def test_브라우저_컨테이너_문지기와_같은_판정():
    for address in REFUSED + ALLOWED:
        assert addresses.is_global_address(address) == guard.is_global_address(address), address
    for address in TUNNELS:
        # 수집기는 터널 대역을 통째로 막습니다 — 문지기가 막는 것(파이썬 판에 따라 막음)을 통과시키는 일은 없음.
        assert addresses.is_global_address(address) is False
        assert not (guard.is_global_address(address) is False and addresses.is_global_address(address) is True)


@pytest.mark.parametrize("url", [
    "ftp://example.com/a", "file:///etc/passwd", "gopher://example.com/", "javascript:alert(1)",
    "https://example.com:8443/a", "http://example.com:22/", "https://user:pass@example.com/a", "https://user@example.com/a",
    "https:///nohost", "", "   ",
    "https://example.com/" + "a" * 2100,
])
def test_scheme_포트_사용자정보_모양이_규칙_밖이면_보내기_전에_막는다(url):
    with pytest.raises(addresses.AddressRefused) as caught:
        addresses.check_url(url)
    assert caught.value.reason == "bad_url"


@pytest.mark.parametrize("url", [
    "http://10.0.0.1/a", "http://127.0.0.1/", "http://[::1]/", "http://[fd7a:115c:a1e0::1]/", "http://169.254.169.254/latest/meta-data/",
    "http://0x7f.1/", "http://2130706433/", "http://127.1/", "http://0177.0.0.1/",
    "http://postgres/", "http://backend:8080/", "http://collector/", "http://browser/", "http://localhost/",
    "https://app.local/", "https://db.internal/x", "https://my-macro-app.example.ts.net/", "https://a.localhost/",
])
def test_IP글자_한_낱말_내부_이름은_보내기_전에_막는다(url):
    with pytest.raises(addresses.AddressRefused) as caught:
        addresses.check_url(url)
    assert caught.value.reason in ("unsafe_address", "bad_url")


def test_조각은_떼고_국제화_도메인은_punycode_경로의_한글은_인코딩():
    target = addresses.check_url("https://한국.kr/기사/1?q=가#top")
    assert target.host == "xn--3e0b707e.kr" and target.port == 443 and target.scheme == "https"
    assert "#" not in target.url and target.url.startswith("https://xn--3e0b707e.kr/")
    assert target.url.isascii()
    plain = addresses.check_url("HTTP://News.Example.COM:80/a/b?x=1")
    assert (plain.host, plain.port, plain.url) == ("news.example.com", 80, "http://news.example.com:80/a/b?x=1")


def test_이름이_하나라도_내부_주소로_풀리면_막는다(monkeypatch):
    monkeypatch.setattr(addresses, "_resolve", lambda host, port: ["93.184.216.34", "10.0.0.7"])
    with pytest.raises(addresses.AddressRefused) as caught:
        addresses.checked_addresses("news.example.com", 443)
    assert caught.value.reason == "unsafe_address" and "news.example.com" in caught.value.message

    monkeypatch.setattr(addresses, "_resolve", lambda host, port: ["169.254.169.254"])
    with pytest.raises(addresses.AddressRefused):
        addresses.checked_addresses("metadata.example.com", 80)


def test_풀리지_않는_이름은_막는다(monkeypatch):
    monkeypatch.setattr(addresses, "_resolve", lambda host, port: [])
    with pytest.raises(addresses.AddressRefused) as caught:
        addresses.checked_addresses("nowhere.example.com", 443)
    assert caught.value.reason == "unresolved"


def test_공인_주소로만_풀리면_그_목록과_고정_줄():
    found = ["2606:4700:4700::1111", "93.184.216.34"]
    assert addresses.pin_entry("news.example.com", 443, found) == "news.example.com:443:93.184.216.34"
    assert addresses.pin_entry("news.example.com", 443, ["2606:4700:4700::1111"]) == "news.example.com:443:[2606:4700:4700::1111]"


def test_검사한_주소_목록을_돌려준다(monkeypatch):
    monkeypatch.setattr(addresses, "_resolve", lambda host, port: ["93.184.216.34", "2606:4700:4700::1111"])
    assert addresses.checked_addresses("news.example.com", 443) == ["93.184.216.34", "2606:4700:4700::1111"]
