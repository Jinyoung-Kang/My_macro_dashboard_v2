/**
 * 좁은 화면(lg 미만) 누르는 자리 44px — 운영 화면 조사(2026-11-15, 390px에서 요소 높이를 잼)가 짚은 곳(QA-458) 가운데 정보 수집 몫. 응답은 모두 합성 값입니다.
 *
 * 조사에서 44px 미만이던 누름 자리: 정보 수집 뉴스·글의 '번역·본문 보기·원문 열기'와 제목 단추(16px 안팎, 49개), 해외·공시·모의매매 입력
 * 출처 카드의 '출처 사이트·자료 보기'(16px). 그린 DOM의 누름 자리마다 클래스로 lg 미만 44px을 따집니다
 * (lib/__tests__/touchTargetAudit — 문장 안의 링크는 WCAG 2.5.8 글 안 예외로 셈에서 뺌).
 *
 * 이 두 사례는 app/(dashboard)/__tests__/touchTargetsQa458.test.tsx에서 글자 그대로 옮겼습니다(작업대 화면 언어 P7 — 정보 수집 화면을 고치는
 * 갈래가 이 파일만 고치게). 수급 레이더 몫은 app/(dashboard)/__tests__/radarTouchTargetsQa458.test.tsx에 있습니다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import InfoHub from "@/components/screens/info/InfoHub";
import { NewsSection } from "@/components/screens/info/NewsSection";
import { SourceTable } from "@/components/screens/info/SourceTable";
import { endpoints } from "@/lib/endpoints";
import { smallTargets } from "@/lib/__tests__/touchTargetAudit";
import type { CatalogSource } from "@/lib/info";

/** 경로 앞부분 → 응답. 긴 앞부분부터 맞추고, 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key === undefined ? new Promise(() => {}) : Promise.resolve(reads[key]);
  });
});
afterEach(() => cleanup());

const CATALOG = { checkedAt: "2026-11-15 10:00 KST", collectorReachable: true, tabs: [], sources: [], incidents: [] };

const ARTICLE = {
  id: "0123456789abcdef01234567", source: "blog.synthetic", sourceLabel: "Synthetic Blog", kind: "article",
  url: "https://blog.example/2026/11/15/rates/", title: "Synthetic rates outlook", titleKo: null, author: "A. Writer",
  publishedAt: "2026-11-15 09:00 KST", firstSeenAt: "2026-11-15 09:30 KST", summary: "합성 요약", bodyStatus: "full",
  fetchTier: null, category: null,
};

const SOURCE: CatalogSource = {
  task: "global_synthetic", key: "synthetic", label: "합성 출처", tab: "global", kind: "feed", siteUrl: "https://source.example/",
  origin: "합성 기관", access: "official", screen: "/macro", speed: "slow", lastStatus: "ok", lastRunAt: "2026-11-15 09:00 KST",
  lastDetail: null, politeStatus: null, streak: null, lastOkAt: "2026-11-15 09:00 KST", nextDueAt: null, items: null, incident: null, tone: "ok",
};

describe("좁은 화면 누르는 자리 44px — 조사가 짚은 화면(QA-458): 정보 수집", () => {
  // 수정 전에는 아래 누름 자리가 모두 걸렸다(재현 커밋에서는 it.fails). 지금은 따로 선 글 링크·단추에 TEXT_TARGET(ui/classes —
  // 좁은 화면 min-h-11, lg 이상 글 높이).
  //  - 정보 수집 뉴스·글: 제목 단추, '번역', '본문 보기', '원문 열기'(블로그 글·헤드라인 모두)
  it("정보 수집 뉴스·글 — 제목 단추와 '번역·본문 보기·원문 열기'", async () => {
    reads = {
      [endpoints.info.catalog]: CATALOG,
      "/api/info/items?kind=blog": { available: true, items: [ARTICLE], page: 1, size: 10, total: 11, pages: 2 },
      "/api/info/headlines?set=world": {
        available: true, page: 1, size: 10, total: 1, pages: 1,
        items: [{ set: "world", title: "Synthetic press release", summary: null, link: "https://press.example/1", source: "Synthetic Wire",
          feed: "synthetic", publishedAt: "2026-11-15 09:00:00 KST", fetchedAt: "2026-11-15T00:10:00+00:00", timeBasis: "published" }],
      },
    };
    const { container } = render(<NewsSection />);
    await screen.findByRole("button", { name: "Synthetic rates outlook" });
    expect(screen.getByRole("link", { name: "원문 열기" })).toBeTruthy();
    const blog = smallTargets(container);
    fireEvent.click(screen.getByRole("radio", { name: "보도자료·경제지" }));
    await screen.findByRole("button", { name: "Synthetic press release" });
    expect([...blog, ...smallTargets(container)]).toEqual([]);
  });

  //  - 해외·공시·모의매매 입력 출처 카드: '출처 사이트', '자료 보기'
  // 작업대 P7부터 분류 탭의 출처 카드는 출처 표(SourceTable)이고, 두 링크는 출처 이름(줄 단추)으로 여는 검사 칸(좁은 화면 대화상자)에 있습니다 —
  // 줄 단추와 두 링크 모두 같은 규칙(lg 미만 44px)으로 셉니다.
  it("정보 수집 출처 카드 — '출처 사이트·자료 보기'", async () => {
    const { container } = render(<SourceTable sources={[SOURCE]} variant="tab" caption="출처" pagerLabel="출처" emptyText="없음" />);
    expect(smallTargets(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "합성 출처" }));
    const dialog = await screen.findByRole("dialog", { name: "합성 출처" });
    expect(screen.getByRole("link", { name: "자료 보기" })).toBeTruthy();
    expect(smallTargets(dialog)).toEqual([]);
  });

  // D1 touch-targets-lt-lg-missed-by-qa458의 정보 수집 몫(그때 16px): 국내 시장·수급의 KRX·네이버 출처 링크, 출처 상태 표의 출처 이름 링크.
  // 작업대 P7 재배치(출처 링크에 공용 LINK_CLASSES — QA-836 고침과 함께, 출처 이름은 줄 단추 InspectorTrigger)로 없어졌는지 그린 DOM 전체로 셉니다 —
  // 재배치 뒤 그냥 it으로 처음부터 통과해 결함 번호를 쓰지 않았습니다(작업대 P6 QA-751·758 선례).
  it("정보 수집 국내 시장·수급·출처 상태 — 출처 링크·고르기·출처 이름·쪽 단추", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ rank: i + 1, code: `00000${i}`.slice(-6), name: `종목${i + 1}`, netAmountEok: 1, netVolume: 1, buyEok: 1, sellEok: 1 }));
    reads = {
      [endpoints.info.catalog]: { ...CATALOG, tabs: [{ key: "kr", label: "국내 시장·수급", sources: 12, tones: { ok: 12 } }],
        sources: Array.from({ length: 12 }, (_, i) => ({ ...SOURCE, task: `kr_${i}`, key: `kr_${i}`, label: `국내 출처 ${i}`, tab: "kr" })) },
      "/api/info/krx": { available: false, ranking: { market: "KOSPI", investor: "외국인", tradeType: "순매수", date: "2026-11-15", rows }, markets: ["KOSPI"], investors: ["외국인"] },
      [endpoints.info.flows]: { available: true, collectedAtKst: "2026-11-15 10:00 KST", ageSeconds: 1, source: "네이버 증권", fetchTier: null, unit: "억원", failed: [],
        sourceUrls: { trader: "https://n.example/t", foreigner: "https://n.example/f", organization: "https://n.example/o" }, trend: { KOSPI: { rows: [] } }, rankings: {} },
    };
    const { container, unmount } = render(<InfoHub tab="kr" />);
    await screen.findByRole("link", { name: "매매동향" });
    await screen.findByRole("button", { name: "국내 출처 0" });
    expect(screen.getByRole("link", { name: "한국거래소 정보데이터시스템(계정 로그인) · 확정치" })).toBeTruthy();
    expect(smallTargets(container)).toEqual([]);
    // 두세 글자 출처 링크는 좁은 화면 폭도 44px(머리 없는 크롬 390에서 '기관' 24px·'외국인' 36px 폭이었음 — ui-audit).
    for (const name of ["외국인", "기관"]) {
      const classes = (screen.getByRole("link", { name }).getAttribute("class") ?? "").split(/\s+/);
      expect(classes, name).toContain("min-w-11");
      expect(classes, name).toContain("lg:min-w-0");
    }
    unmount();

    const status = render(<InfoHub tab="status" />);
    await screen.findByRole("button", { name: "국내 출처 0" });
    expect(smallTargets(status.container)).toEqual([]);
  });
});
