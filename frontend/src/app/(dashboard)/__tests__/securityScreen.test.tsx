/**
 * 보안 공지 화면(/security — ADR 0046, 운영자 전용·읽기만). 응답은 모두 가짜 값입니다(글 번호 9000xx, CVE-2099-*, 실제로 없는 큰 버전 — 실제 서버 버전·공지 원문 아님).
 * - 네 판정은 아이콘 + 글(색만이 아님), 사유는 한국어 글
 * - 거르기(판정·사유)와 검색이 API 인자(verdict·reason·q)로 가고 첫 쪽부터 다시 읽음
 * - 검사 칸: 행마다 영향·해결 버전·판정·설치 버전, ※ 조건 문장 안내 상자, 원문 링크(새 창)
 * - 버전 목록 없음 안내·오래됨 경고·한계 한 줄(늘)·수집 상태 한 줄
 * - 알림함 링크 ?ntt=<번호>가 그 공지의 검사 칸을 엶(좁은 화면 대화상자·넓은 화면 옆 칸)
 * - 회원·데모에게는 메뉴가 없음, 이 화면은 GET만(쓰기 0)
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/security",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { TABS, navSearchItems, visibleItems } from "@/lib/nav";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";
import SecurityPage from "../security/page";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };

const INVENTORY = {
  collectedAt: "2026-11-20T15:00:00Z", receivedAt: "2026-11-20T15:00:05Z", ageSeconds: 36_000, stale: false,
  hostIncluded: true, aptListsAt: "2026-11-20T12:00:00Z", notOkSections: [],
};
const COLLECTION = {
  task: "kisa_security_notices", recorded: true, status: "ok", streak: 2, reason: null, lastOkAt: "2026-11-21T00:00:00Z",
  lastRunAt: "2026-11-21T00:00:00Z", staleAfterMinutes: 720, notices: 4, details: { pending: 0, ok: 4, failed: 0, skipped: 0 },
  oldestPostedOn: "2026-11-17", newestPostedOn: "2026-11-20",
};

function item(nttId: number, title: string, verdict: string, reasons: string[], products: { label: string; status: string }[]) {
  return {
    nttId, title, postedOn: `2026-11-${String(20 - (nttId % 10)).padStart(2, "0")}`, url: `https://example.invalid/qa/${nttId}`, pinned: false,
    detailStatus: "ok", layout: "product_table", verdict, reasons, conditionNote: reasons.includes("CONDITION_NOTE"),
    products: products.map((product) => ({ aliasId: product.label.toLowerCase(), label: product.label, status: product.status, reasons })),
    rowCount: 1, cveCount: 1,
  };
}

const ITEMS = [
  item(900001, "[가짜] 합성 DB 보안 업데이트 권고", "affected", [], [{ label: "PostgreSQL", status: "affected" }]),
  item(900002, "[가짜] 합성 런타임 보안 업데이트 권고", "patched", [], [{ label: "Node.js", status: "patched" }]),
  item(900003, "[가짜] 합성 언어 보안 업데이트 권고", "check", ["CONDITION_NOTE"], [{ label: "Python", status: "check" }]),
  item(900004, "[가짜] 합성 웹 서버 보안 업데이트 권고", "unrelated", [], []),
];

function noticesResponse(over: Record<string, unknown> = {}) {
  return {
    available: true, checkedAt: "2026-11-21T01:00:00Z", inventory: INVENTORY, collection: COLLECTION,
    counts: { affected: 1, check: 1, patched: 1, unrelated: 1, total: 4 },
    reasonCounts: { PARSE_FAILED: 0, OUT_OF_TABLE: 0, DISTRO_NO_PENDING: 0, NO_INVENTORY: 0, CONDITION_NOTE: 1, NO_VERSION_TABLE: 0, NAME_MATCH: 0, VENDOR_DIFFERS: 0 },
    items: ITEMS, page: 1, size: 20, total: 4, pages: 1, ...over,
  };
}

const DETAIL_900001 = {
  available: true, checkedAt: "2026-11-21T01:00:00Z", inventory: INVENTORY,
  notice: {
    ...ITEMS[0], listNo: 99001, firstSeenAt: "2026-11-20T03:00:00Z", detailFetchedAt: "2026-11-20T03:00:10Z", detailAttempts: 1, detailError: null,
    noticeProducts: ["PostgreSQL"], notes: ["※ 가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)"], conditionNotes: ["※ 가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)"],
    bodyText: "가짜 본문",
  },
  rows: [
    {
      index: 0, cve: "CVE-2099-90001", product: "PostgreSQL", affected: "90.0 이상 90.5 미만", fixed: "90.5",
      aliases: [{ aliasId: "postgres", label: "PostgreSQL" }], status: "affected", reasons: [],
      matches: [{ aliasId: "postgres", label: "PostgreSQL", rowIndex: 0, cve: "CVE-2099-90001", rowProduct: "PostgreSQL", source: "postgres",
        component: "postgresql", installedVersion: "90.2", status: "affected", reason: null, otherFamily: false }],
    },
    {
      index: 1, cve: "CVE-2099-90002", product: "PostgreSQL", affected: "89.0 이상 89.9 미만", fixed: "89.9",
      aliases: [{ aliasId: "postgres", label: "PostgreSQL" }], status: "unrelated", reasons: [],
      matches: [{ aliasId: "postgres", label: "PostgreSQL", rowIndex: 1, cve: "CVE-2099-90002", rowProduct: "PostgreSQL", source: "postgres",
        component: "postgresql", installedVersion: "90.2", status: "unrelated", reason: null, otherFamily: true }],
    },
  ],
  generalMatches: [{ aliasId: "openssl", label: "OpenSSL", rowIndex: null, cve: null, rowProduct: null, source: "host", component: "libfake3",
    installedVersion: "9.9.9-0fake1", status: "check", reason: "DISTRO_NO_PENDING", otherFamily: false }],
};

const LIST = endpoints.security.notices({ page: 1, size: 20 });
let reads: Record<string, unknown> = {};

beforeEach(() => {
  nav.search = "";
  reads = { [LIST]: noticesResponse(), [endpoints.security.notice(900001)]: DETAIL_900001 };
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settled() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}
const calledPaths = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);

async function renderPage(user: SessionUser = OWNER) {
  render(<SessionUserProvider user={user}><SecurityPage /></SessionUserProvider>);
  await screen.findByRole("heading", { level: 1, name: "보안 공지" });
  await settled();
}

function stubWide() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === WIDE_SHELL_MEDIA, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

/** 공지 표의 그 제목 행. */
function rowOf(title: string): HTMLTableRowElement {
  return screen.getByRole("button", { name: title }).closest("tr") as HTMLTableRowElement;
}

describe("보안 공지 — 목록", () => {
  it("네 판정은 아이콘 + 글(판정마다 다른 아이콘), 해당은 낭독기 '주의: ', 사유는 한국어 글", async () => {
    await renderPage();
    const expected: [string, string][] = [
      ["[가짜] 합성 DB 보안 업데이트 권고", "해당"],
      ["[가짜] 합성 런타임 보안 업데이트 권고", "패치됨"],
      ["[가짜] 합성 언어 보안 업데이트 권고", "확인 필요"],
      ["[가짜] 합성 웹 서버 보안 업데이트 권고", "무관"],
    ];
    const icons = new Set<string>();
    for (const [title, label] of expected) {
      const cell = rowOf(title).cells[0];
      expect(within(cell).getByText(label)).toBeTruthy();
      const svg = cell.querySelector("svg");
      expect(svg).toBeTruthy();
      expect(svg?.closest("[aria-hidden='true']") ?? svg?.getAttribute("aria-hidden")).toBeTruthy();
      icons.add(svg?.innerHTML ?? "");
    }
    expect(icons.size).toBe(4);
    expect(rowOf("[가짜] 합성 DB 보안 업데이트 권고").cells[0].textContent).toBe("주의: 해당");
    expect(rowOf("[가짜] 합성 언어 보안 업데이트 권고").textContent).toContain("조건 문장 있음");
    expect(screen.queryByText("CONDITION_NOTE")).toBeNull();
  });

  it("KPI 띠는 해당·확인 필요·패치됨·버전 목록 기준(KST), 한계 한 줄과 수집 상태 한 줄이 보인다", async () => {
    await renderPage();
    const kpi = screen.getByRole("region", { name: "판정 요약" });
    for (const name of ["해당", "확인 필요", "패치됨", "버전 목록 기준"]) expect(within(kpi).getByRole("group", { name })).toBeTruthy();
    expect(within(within(kpi).getByRole("group", { name: "버전 목록 기준" })).getByText("2026-11-21 00:00")).toBeTruthy();
    expect(screen.getByText(/보호나라는 이 스택의 일부만 다룹니다 — 여기서 해당이 없어도/)).toBeTruthy();
    expect(screen.getByText(/^수집 정상 · 마지막 성공 2026-11-21 09:00 · 받아 둔 공지 4건/)).toBeTruthy();
    expect(screen.queryByText(/버전 목록 없음 — 서버에서 inventory.sh/)).toBeNull();
  });

  it("판정·사유 거르기와 검색은 API 인자(verdict·reason·q)로 — 고르면 첫 쪽부터 다시 읽는다", async () => {
    reads[endpoints.security.notices({ verdict: "check", page: 1, size: 20 })] = noticesResponse({ items: [ITEMS[2]], total: 1 });
    reads[endpoints.security.notices({ verdict: "check", reason: "CONDITION_NOTE", page: 1, size: 20 })] = noticesResponse({ items: [ITEMS[2]], total: 1 });
    await renderPage();
    expect(calledPaths()).toEqual([LIST]);

    fireEvent.click(within(screen.getByRole("radiogroup", { name: "판정" })).getByRole("radio", { name: "확인 필요" }));
    await settled();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "사유" })).getByRole("radio", { name: "조건 문장 있음" }));
    await settled();
    fireEvent.change(screen.getByLabelText("제목·제품·CVE 검색"), { target: { value: " CVE-2099 & 가짜 " } });
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    await settled();

    expect(calledPaths()).toEqual([
      LIST,
      "/api/security/notices?verdict=check&page=1&size=20",
      "/api/security/notices?verdict=check&reason=CONDITION_NOTE&page=1&size=20",
      `/api/security/notices?verdict=check&reason=CONDITION_NOTE&q=${encodeURIComponent("CVE-2099 & 가짜")}&page=1&size=20`,
    ]);
    // 판정 거르기의 건수(검색어로만 거른 수)는 판정을 바꿔 다시 읽는 동안에도 이어 씀 — 검색어를 바꾸면 이어 쓰지 않음.
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("표가 없으면(수집기가 새 스키마 전) 안내, 읽기 실패면 오류와 다시 시도", async () => {
    reads[LIST] = noticesResponse({ available: false, inventory: null, collection: null, counts: null, reasonCounts: null, items: [], total: 0, pages: 0 });
    await renderPage();
    expect(screen.getByText(/보안 공지 표가 아직 없습니다/)).toBeTruthy();
    expect(screen.getByText(/보호나라는 이 스택의 일부만 다룹니다/)).toBeTruthy();
  });
});

describe("보안 공지 — 버전 목록 안내", () => {
  it("버전 목록이 없으면 '버전 목록 없음 — inventory.sh' 안내와 KPI 기준 시각 '—'", async () => {
    reads[LIST] = noticesResponse({ inventory: null });
    await renderPage();
    expect(screen.getByText("버전 목록 없음 — 서버에서 inventory.sh가 돈 뒤에 생깁니다.")).toBeTruthy();
    const basis = within(screen.getByRole("region", { name: "판정 요약" })).getByRole("group", { name: "버전 목록 기준" });
    expect(basis.textContent).toContain("—");
  });

  it("2일 넘게 오래됐으면 경고, 모으지 못한 구역은 이름으로", async () => {
    reads[LIST] = noticesResponse({ inventory: { ...INVENTORY, ageSeconds: 3 * 86_400, stale: true, notOkSections: ["browser"] } });
    await renderPage();
    expect(screen.getByText(/버전 목록이 2일 넘게 오래됐습니다\(기준 2026-11-21 00:00 — 3일 전\)/)).toBeTruthy();
    expect(screen.getByText(/모으지 못한 구역: browser/)).toBeTruthy();
    expect(screen.getByText("2일 넘게 오래됨")).toBeTruthy();
  });

  it("버전 목록 탭 — 열 때만 읽고, 받은 적이 없으면 '버전 목록 없음' 안내", async () => {
    reads[endpoints.security.inventory] = {
      available: true, checkedAt: "2026-11-21T01:00:00Z", present: false, collectedAt: null, receivedAt: null, ageSeconds: null, stale: null,
      hostIncluded: null, aptListsAt: null, sections: [], counts: null, components: [], pending: [],
    };
    await renderPage();
    expect(calledPaths()).not.toContain(endpoints.security.inventory);
    fireEvent.click(screen.getByRole("tab", { name: "버전 목록" }));
    await settled();
    expect(calledPaths()).toContain(endpoints.security.inventory);
    expect(within(screen.getByRole("tabpanel")).getByText("버전 목록 없음 — 서버에서 inventory.sh가 돈 뒤에 생깁니다.")).toBeTruthy();
  });

  it("버전 목록 탭 — 구역 상태(아이콘 + 글)·보류 업데이트·구성 요소(화면 안 거르기)", async () => {
    reads[endpoints.security.inventory] = {
      available: true, checkedAt: "2026-11-21T01:00:00Z", present: true, collectedAt: "2026-11-20T15:00:00Z", receivedAt: "2026-11-20T15:00:05Z",
      ageSeconds: 36_000, stale: false, hostIncluded: true, aptListsAt: "2026-11-20T12:00:00Z",
      sections: [{ name: "host", status: "ok", count: 1, reason: null }, { name: "browser", status: "failed", count: null, reason: "가짜 실패" }],
      counts: { components: 2, pending: 1, pendingSecurity: 1 },
      components: [
        { source: "host", ecosystem: "dpkg", name: "libfake3", version: "9.9.9-0fake1", sourcePackage: "fakessl" },
        { source: "backend", ecosystem: "maven", name: "fake-core", version: "99.1.0", sourcePackage: null },
      ],
      pending: [{ package: "libfake3", arch: "amd64", installed: "9.9.9-0fake1", candidate: "9.9.9-0fake2", repos: "fake-security", security: true }],
    };
    await renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "버전 목록" }));
    await settled();
    const panel = screen.getByRole("tabpanel");
    const sections = within(panel).getByRole("table", { name: "구역" });
    expect(within(sections).getByText("모음")).toBeTruthy();
    expect(within(sections).getByText("실패")).toBeTruthy();
    expect(within(panel).getByRole("table", { name: "apt 보류 업데이트" }).textContent).toContain("보안");
    const components = () => within(panel).getByRole("table", { name: "구성 요소" });
    expect(within(components()).getByText("fake-core")).toBeTruthy();
    fireEvent.click(within(within(panel).getByRole("radiogroup", { name: "구역" })).getByRole("radio", { name: "서버 호스트" }));
    expect(within(components()).queryByText("fake-core")).toBeNull();
    expect(within(components()).getByText("libfake3")).toBeTruthy();
    expect(calledPaths().filter((path) => path === endpoints.security.inventory)).toHaveLength(1);
  });
});

describe("보안 공지 — 검사 칸", () => {
  it("제목을 고르면 그 공지를 읽어 행마다 영향·해결 버전·판정·설치 버전, ※ 조건 문장 안내 상자, 원문 링크(새 창)", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "[가짜] 합성 DB 보안 업데이트 권고" }));
    const dialog = await screen.findByRole("dialog", { name: "[가짜] 합성 DB 보안 업데이트 권고" });
    await within(dialog).findByText("표 행 2개");
    expect(calledPaths()).toContain(endpoints.security.notice(900001));
    expect(within(dialog).getByText("90.0 이상 90.5 미만")).toBeTruthy();
    expect(within(dialog).getAllByText("postgresql 90.2(postgres)").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("postgresql 90.2(postgres) · 다른 계열")).toBeTruthy();
    expect(within(dialog).getByText("표 밖 조건 문장(※)")).toBeTruthy();
    expect(within(dialog).getByText("※ 가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)")).toBeTruthy();
    expect(within(dialog).getByText("행에 매이지 않는 근거")).toBeTruthy();
    expect(within(dialog).getByText("배포판 패키지 — 보류 목록에 없음")).toBeTruthy();
    const link = within(dialog).getByRole("link", { name: /보호나라 원문 열기\(새 창\)/ });
    expect(link.getAttribute("href")).toBe("https://example.invalid/qa/900001");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("알림함 링크 ?ntt=<번호>는 그 공지의 검사 칸을 연다 — 좁은 화면은 대화상자", async () => {
    nav.search = "?ntt=900001";
    await renderPage();
    const dialog = await screen.findByRole("dialog", { name: "[가짜] 합성 DB 보안 업데이트 권고" });
    await within(dialog).findByText("표 행 2개");
  });

  it("?ntt=의 공지가 지금 쪽에 없어도 연다(제목 '보안 공지 <번호>'), 숫자가 아니면 열지 않는다", async () => {
    reads[endpoints.security.notice(900099)] = { ...DETAIL_900001, notice: { ...DETAIL_900001.notice, nttId: 900099, title: "[가짜] 지난 공지" } };
    nav.search = "?ntt=900099";
    await renderPage();
    const dialog = await screen.findByRole("dialog", { name: "보안 공지 900099" });
    await within(dialog).findByText("표 행 2개");
    cleanup();

    nav.search = "?ntt=abc";
    await renderPage();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("넓은 화면은 ?ntt=의 공지를 옆 검사 칸에 고른다(표의 그 행이 고른 행)", async () => {
    stubWide();
    nav.search = "?ntt=900001";
    await renderPage();
    const inspector = await screen.findByRole("region", { name: "보안 공지 — [가짜] 합성 DB 보안 업데이트 권고" });
    await within(inspector).findByText("표 행 2개");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowOf("[가짜] 합성 DB 보안 업데이트 권고").getAttribute("aria-current")).toBeTruthy();
  });
});

describe("보안 공지 — 메뉴와 쓰기", () => {
  it("운영자에게만 메뉴(더보기 '묶음 없음'의 외부 API 연결 테스트 다음) — 회원·데모·모르는 사용자에게는 없음", () => {
    const more = TABS.find((tab) => tab.key === "more")!;
    const owner = visibleItems(more, OWNER).map((entry) => entry.href);
    expect(owner.indexOf("/security")).toBe(owner.indexOf("/connections") + 1);
    expect(more.items.find((entry) => entry.href === "/security")).toMatchObject({ label: "보안 공지" });
    for (const user of [MEMBER, DEMO, undefined]) {
      expect(visibleItems(more, user).map((entry) => entry.href)).not.toContain("/security");
      expect(navSearchItems(user).map((entry) => entry.href)).not.toContain("/security");
    }
  });

  it("이 화면은 GET만 — 거르기·검색·탭·검사 칸을 써도 POST·DELETE 0", async () => {
    await renderPage();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "판정" })).getByRole("radio", { name: "해당" }));
    await settled();
    fireEvent.click(screen.getByRole("tab", { name: "버전 목록" }));
    await settled();
    fireEvent.click(screen.getByRole("tab", { name: "공지" }));
    await settled();
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(api.apiDelete).not.toHaveBeenCalled();
    expect(api.apiGet).not.toHaveBeenCalled();
    expect(calledPaths().every((path) => path.startsWith("/api/security/"))).toBe(true);
  });
});
