/**
 * 정보 검색 대상 화면의 속성 칸 글(QA-420 후속 — 미리 보기 안내, QA-429 후속 — 받지 못한 출처·푼 출처의 이름, QA-431 — 풀지 못한 대상의 종류).
 * 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 *
 * jsdom은 미디어 쿼리를 셈하지 않습니다. 그래서 그 창 폭에서 보이는 글을 클래스의 display(hidden·inline 등과 그 앞의 lg:·xl: 등)로 셈해
 * 읽습니다(배치를 클래스 계약으로 시험 — 실제 화면은 QA 스택에서 봄).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("./fakeNavigation"));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { entityErrorSourceLabel } from "@/lib/infoSearch";
import type { SearchEntity, SearchFeedItem, SessionUser } from "@/lib/types";
import { AttributesPanel } from "../EntityParts";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: "미국의 반도체 기업",
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477", lei: null },
  links: [{ relation: "subsidiary", key: "wd:Q100", name: "Mellanox", kind: "company", source: "wikidata" }],
  sources: ["sec", "wikidata"],
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null, ...over,
  };
}

function feed(items: SearchFeedItem[]) {
  const count = items.length;
  return {
    available: true, entityKey: "us:NVDA", tab: "timeline", items,
    sources: [{ source: "google_en", label: "구글 뉴스(영어)", status: count > 0 ? "ok" : "empty", count, dropped: null, message: null }],
    window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": count, "30d": count, "1y": count, "2y": count },
    olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00",
  };
}

const LINKS = { available: true, entityKey: "us:NVDA", links: [], sources: [], fetchedAt: "2026-11-14T01:00:00+00:00" };

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

function renderScreen(path: string) {
  setLocation(path);
  return render(
    <SessionUserProvider user={MEMBER}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

beforeEach(() => {
  reads = {};
  api.apiGet.mockReset();
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
});
afterEach(() => cleanup());

/** 속성 칸 — 대상이 풀려 설명까지 그린 뒤. */
async function attributesPane(): Promise<HTMLElement> {
  const pane = await screen.findByRole("region", { name: "속성" });
  await within(pane).findByText("미국의 반도체 기업");
  return pane;
}

// ------------------------------------------------------------------ 창 폭별로 보이는 글(셸의 값 — 바뀌면 여기도 고침)

const BREAKPOINTS: Record<string, number> = { "": 0, "sm:": 640, "md:": 768, "lg:": 1024, "xl:": 1280, "2xl:": 1536 };
const DISPLAY = /^((?:sm|md|lg|xl|2xl):)?(hidden|block|inline|inline-block|inline-flex|flex|inline-grid|grid|contents|table)$/;

/** 그 창 폭에서 이 요소가 보이는가 — display 클래스 가운데 앞머리(lg: 등)가 창 폭 이하로 가장 큰 것으로 셈(없으면 보임). */
function shownAt(element: Element, viewport: number): boolean {
  let best: { min: number; hidden: boolean } | null = null;
  for (const token of (element.getAttribute("class") ?? "").split(/\s+/)) {
    const match = DISPLAY.exec(token);
    if (!match) continue;
    const min = BREAKPOINTS[match[1] ?? ""];
    if (min <= viewport && (!best || min >= best.min)) best = { min, hidden: match[2] === "hidden" };
  }
  return !best?.hidden;
}

/** 그 창 폭에서 보이는 글 — 숨은 요소(display:none — 낭독기도 읽지 않음)의 글은 뺍니다. */
function textAt(node: Node, viewport: number): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && !shownAt(node, viewport)) return "";
  return [...node.childNodes].map((child) => textAt(child, viewport)).join("");
}

const HINT = /미리 보기가 나옵니다/;

describe("QA-420 후속 — 속성 칸의 미리 보기 안내가 그 탭·그 창 폭의 동작과 맞음", () => {
  // QA-420: 안내 '줄을 고르면 이 칸에 그 글의 미리 보기가 나옵니다'를 속성 칸이 늘 그려 고를 줄이 없는 보유·연결 탭에도 보였음(1판부터).
  // 수정 전 실패: 보유·연결 탭의 속성 칸에 안내가 있음(재현 커밋에서는 it.fails).
  it("보유·연결 탭의 속성 칸에는 줄 미리 보기 안내가 없다(고를 줄이 없음)", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.links("us:NVDA")] = LINKS;
    for (const tab of ["holdings", "links"]) {
      renderScreen(`/search?e=us:NVDA&tab=${tab}&range=30d`);
      expect(screen.getByRole("tab", { selected: true }).textContent).toBe(tab === "holdings" ? "보유" : "연결");
      expect((await attributesPane()).textContent, tab).not.toMatch(HINT);
      cleanup();
    }
  });

  // QA-420: lg(1024~1279)도 xl 미만이라 고른 줄의 미리 보기가 이 칸이 아니라 화면 아래 시트로 뜸(lg 미만은 전부터) — 안내는 '이 칸에'라고 말했음.
  // 수정 전 실패: 1024·390에서 보이는 안내가 '이 칸에'라고 말함(재현 커밋에서는 it.fails).
  it("결과 탭의 안내는 xl 미만에서 화면 아래(시트)를, xl부터 이 칸을 가리킨다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed([row({ id: "r1", title: "첫째 기사" })]);
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    await screen.findByRole("listbox", { name: "결과" });
    const pane = await attributesPane();
    for (const viewport of [390, 1024, 1279]) {
      const text = textAt(pane, viewport);
      expect({ viewport, hint: HINT.test(text), here: text.includes("이 칸"), below: text.includes("화면 아래") }).toEqual({
        viewport, hint: true, here: false, below: true,
      });
    }
    for (const viewport of [1280, 1440]) {
      const text = textAt(pane, viewport);
      expect({ viewport, hint: HINT.test(text), here: text.includes("이 칸"), below: text.includes("화면 아래") }).toEqual({
        viewport, hint: true, here: true, below: false,
      });
    }
  });

  // QA-420: 결과가 없으면 고를 줄이 없는데도 안내가 보였음. 수정 전 실패: 빈 결과의 속성 칸에 안내가 있음(재현 커밋에서는 it.fails).
  it("결과 탭이라도 고를 줄이 없으면(빈 결과) 안내를 두지 않는다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed([]);
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    await screen.findByText("최근 2년 안의 자료가 없습니다");
    expect((await attributesPane()).textContent).not.toMatch(HINT);
  });
});

describe("QA-429 후속 — 속성 칸의 '대상을 푸는 데 받지 못한 출처'는 출처 키 대신 이름을 보인다", () => {
  const line = () => screen.getByText(/대상을 푸는 데 받지 못한 출처/).textContent ?? "";

  // QA-429: 속성 칸이 대상 풀기 errors의 키를 그대로 붙여 새 내부 키가 'dart_store: DART 고유번호 저장본을 읽지 못함'으로 보였음
  // (sec·wikidata·dart·entity도 키 그대로). 수정 전 실패: 줄에 'dart_store'·'wikidata' 같은 키가 그대로 있음(재현 커밋에서는 it.fails).
  it("수집기가 보내는 키(entity·wikidata·sec·dart·dart_store)는 출처 이름으로, 모르는 키는 중립 이름으로 보인다", () => {
    render(
      <AttributesPanel
        entity={null}
        kind="company"
        errors={{
          dart_store: "DART 고유번호 저장본을 읽지 못함",
          wikidata: "시간 초과",
          sec: "HTTP 503",
          entity: "대상 풀기가 8초를 넘어 저장본 이름으로만 답함",
          new_source: "합성 사유",
        }}
      />,
    );
    const text = line();
    for (const code of ["dart_store", "wikidata", "sec:", "entity", "new_source"]) expect(text, code).not.toContain(code);
    expect(text).toContain("DART: DART 고유번호 저장본을 읽지 못함");
    expect(text).toContain("Wikidata: 시간 초과");
    expect(text).toContain("SEC: HTTP 503");
    expect(text).toContain("외부 출처: 대상 풀기가 8초를 넘어 저장본 이름으로만 답함");
    expect(text).toContain("기타 출처: 합성 사유");
    cleanup();

    render(<AttributesPanel entity={null} kind="company" errors={{ dart: "DART 고유번호 저장본에 이 종목이 없음" }} />);
    expect(line()).toContain("DART: DART 고유번호 저장본에 이 종목이 없음");
    expect(line()).not.toContain("dart:");
  });

  it("객체 기본 속성 이름(toString 등)의 키도 코드 이름 대신 기타 출처로 보인다", () => {
    for (const key of ["toString", "constructor", "__proto__", ""]) expect(entityErrorSourceLabel(key), key).toBe("기타 출처");
  });

  /** 속성 칸 표의 '푼 출처' 값. */
  const solvedBy = () => screen.getByText("푼 출처").nextElementSibling?.textContent;

  // QA-429(검토 지적): 같은 속성 칸의 '푼 출처' 줄은 entity.sources의 키를 그대로 이어 붙여, 바로 아래 받지 못한 출처 줄('SEC'·'Wikidata')과
  // 달리 'sec · wikidata'로 보였고 '13f'·'universe' 같은 코드 이름도 화면 글에 남았음.
  // 수정 전 실패: '푼 출처'가 'sec · wikidata'·'13f · universe · dart · new_source'(키 그대로).
  it.fails("'푼 출처' 줄도 수집기 키(sec·wikidata·13f·universe·dart) 대신 받지 못한 출처 줄·후보 목록과 같은 이름을 보인다", () => {
    render(<AttributesPanel entity={NVIDIA as SearchEntity} kind={null} errors={{ wikidata: "시간 초과" }} />);
    expect(solvedBy()).toBe("SEC · Wikidata");
    expect(line()).toContain("Wikidata: 시간 초과");
    cleanup();

    const sources = ["13f", "universe", "dart", "new_source", "other_source"];
    render(<AttributesPanel entity={{ ...(NVIDIA as SearchEntity), sources }} kind={null} errors={{}} />);
    // 모르는 키는 코드 이름 대신 '기타 출처' 하나(같은 이름을 거듭 잇지 않음).
    expect(solvedBy()).toBe("13F 기관 · 종목 유니버스 · DART · 기타 출처");
  });
});

describe("QA-431 — 풀지 못한 wd: 대상의 속성 칸 종류는 확인한 값만(탭을 고르려고 짐작한 '사람'을 보이지 않음)", () => {
  /** 속성 칸의 '종류' 값. */
  const kindValue = (pane: HTMLElement) => within(pane).getByText("종류").nextElementSibling?.textContent;

  // QA-431: wd: 키를 풀지 못하면(Wikidata 실패 — entity:null) 탭을 고르려고 사람으로 짐작한 종류를 속성 칸에도 넘겨, 머리는 '대상'(모름)인데
  // 속성 칸은 '종류 사람'이었음. 결과 탭은 FeedPanel을 거쳐, 보유·연결 탭은 EntityView에서 바로 넘김.
  // 수정 전 실패: 공시·연결 탭 모두 속성 칸 종류가 '사람'(재현 커밋에서는 it.fails).
  it("공시 탭(결과 탭)과 연결 탭의 속성 칸 종류가 '—'이고 '사람'이 없다", async () => {
    reads[endpoints.search.entity("wd:Q4000002")] = { available: true, entity: null, errors: { wikidata: "ProxyError" } };
    for (const tab of ["filings", "links"]) {
      renderScreen(`/search?e=wd:Q4000002&tab=${tab}&range=30d`);
      const pane = await screen.findByRole("region", { name: "속성" });
      expect(screen.getByRole("tab", { selected: true }).textContent).toBe(tab === "filings" ? "공시" : "연결");
      expect({ tab, kind: kindValue(pane) }).toEqual({ tab, kind: "—" });
      expect(pane.textContent, tab).not.toContain("사람");
      cleanup();
    }
  });
});
