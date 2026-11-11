"""
app/services/info_text.py
정보 수집(ADR 0035)의 글자 다루기 — HTML을 글로, 글 페이지에서 본문 고르기, 원문 주소 정규화와 글 id. 네트워크를 모릅니다.

  - 본문은 글자만 남깁니다(문단 사이는 빈 줄 하나). 스크립트·스타일·그림·양식·내비게이션·머리말·꼬리말·옆 칸은 버립니다.
  - 워드프레스 피드가 끝에 붙이는 "The post … appeared first on …" 줄은 본문이 아니라 지웁니다.
  - 글 id는 정규화한 주소(https·소문자 호스트·앞의 www. 없음·추적 인자와 조각 없음·끝의 / 없음)의 해시 앞 24자입니다 — waedge 해외 블로그 목록과
    원문 피드가 같은 글을 같은 행으로 모읍니다.
"""
from __future__ import annotations

import hashlib
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup

class ShapeError(ValueError):
    """출처의 응답 모양이 달라 읽지 못함(목록·피드에서 항목을 하나도 못 읽음, 필수 칸 없음). 태스크가 '형식 바뀜'으로 남깁니다."""


# 본문으로 볼 최소 글자 수 — 이보다 짧으면 요약이거나 본문을 못 고른 것입니다.
MIN_BODY_CHARS = 400
# 목록에 보일 요약의 길이(글자).
SUMMARY_CHARS = 300

_DROP_TAGS = ("script", "style", "noscript", "svg", "form", "nav", "header", "footer", "aside", "iframe", "button",
              "figure", "template", "select", "input", "textarea", "picture", "video", "audio", "canvas", "object")
_BLOCK_TAGS = ("p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "tr", "dd", "dt", "figcaption", "div")
# 글 페이지에서 본문을 담는 자리로 흔한 것(앞의 것부터). 글자가 MIN_BODY_CHARS 넘는 첫 자리를 씁니다.
_BODY_SELECTORS = ("[itemprop=articleBody]", ".entry-content", ".post-content", ".article-content", ".post-body",
                   ".single-post-content", ".available-content", ".body.markup", "article", "main")
_TRACKING = re.compile(r"^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref_src)$", re.IGNORECASE)
_APPEARED_FIRST = re.compile(r"^The post .{1,300} appeared first on .{1,200}\.?$", re.IGNORECASE)
_SPACES = re.compile(r"[ \t ​]+")


def normalize_url(url: str) -> str:
    """같은 글의 주소를 하나로 — 스킴 https, 소문자 호스트(앞의 www. 없음), 추적 인자·조각 없음, 끝의 / 없음."""
    parts = urlsplit((url or "").strip())
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _TRACKING.match(k)])
    path = parts.path or "/"
    if len(path) > 1:
        path = path.rstrip("/")
    return urlunsplit(("https", host, path, query, ""))


def item_id(url: str) -> str:
    """글 id — 정규화한 주소의 sha1 앞 24자."""
    return hashlib.sha1(normalize_url(url).encode("utf-8")).hexdigest()[:24]


def _clean_lines(text: str) -> str:
    lines = [_SPACES.sub(" ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if not _APPEARED_FIRST.match(line)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _node_text(node) -> str:
    for tag in node.find_all(_DROP_TAGS):
        tag.decompose()
    for br in node.find_all("br"):
        br.replace_with("\n")
    for block in node.find_all(_BLOCK_TAGS):
        block.insert_before("\n\n")
        block.insert_after("\n\n")
    return _clean_lines(node.get_text())


def html_to_text(markup: str | None) -> str:
    """HTML 조각(피드 본문·요약)을 글로. 비었으면 빈 문자열."""
    if not markup or not markup.strip():
        return ""
    if "<" not in markup:
        return _clean_lines(markup)
    return _node_text(BeautifulSoup(markup, "lxml"))


def extract_article(markup: str | None) -> str:
    """
    글 페이지 HTML에서 본문 글을 고릅니다. 흔한 본문 자리(_BODY_SELECTORS)에서 MIN_BODY_CHARS를 넘는 첫 것을 쓰고, 없으면 문단(<p>)이
    가장 많이 모인 상자를 씁니다. 못 고르면 빈 문자열입니다(0으로 채우듯 엉뚱한 글을 본문으로 내지 않음).
    """
    if not markup:
        return ""
    soup = BeautifulSoup(markup, "lxml")
    for tag in soup.find_all(_DROP_TAGS):
        tag.decompose()
    for selector in _BODY_SELECTORS:
        for node in soup.select(selector):
            text = _node_text(node)
            if len(text) >= MIN_BODY_CHARS:
                return text
    scores: dict[int, tuple[object, int]] = {}
    for paragraph in soup.find_all("p"):
        parent = paragraph.parent
        if parent is None:
            continue
        node, score = scores.get(id(parent), (parent, 0))
        scores[id(parent)] = (node, score + len(paragraph.get_text(strip=True)))
    if not scores:
        return ""
    node, score = max(scores.values(), key=lambda pair: pair[1])
    if score < MIN_BODY_CHARS:
        return ""
    return _node_text(node)


def summarize(text: str, limit: int = SUMMARY_CHARS) -> str | None:
    """목록에 보일 앞부분 — 첫 문단부터 ``limit``자까지(넘으면 말줄임). 비었으면 None."""
    flat = _SPACES.sub(" ", (text or "").replace("\n", " ")).strip()
    if not flat:
        return None
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"
