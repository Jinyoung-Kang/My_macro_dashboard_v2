/**
 * 보안 공지 화면(/security — ADR 0046, 운영자 전용). 응답은 모두 가짜 값입니다(글 번호 9000xx, CVE-2099-*, 실제로 없는 큰 버전 — 실제 서버 버전·공지 원문 아님).
 * - 네 판정은 아이콘 + 글(색만이 아님), 사유는 한국어 글
 * - 거르기(판정·사유)와 검색이 API 인자(verdict·reason·q)로 가고 첫 쪽부터 다시 읽음
 * - 요약 칸(2026-11-21 사용자 결정): 판정·사유 한 줄, 이 환경에 걸린 것(해당·확인 필요만 — 패치됨 행은 그리지 않음), '패치됨 N개 · 무관 N개' 한 줄,
 *   ※ 조건 문장 수, '자세히 보기'(팝업 — 상세 구역 ①~⑤, 다시 읽지 않음)·원문 링크(새 창) — 행 표 전체는 그리지 않음, 새 사유 DISTRO_OPEN·추적기 칸 있음/없음
 * - 버전 목록 없음 안내·오래됨 경고·한계 한 줄(늘)·수집 상태 한 줄
 * - 알림함 링크 ?ntt=<번호>가 그 공지의 요약 칸을 엶(좁은 화면 대화상자·넓은 화면 옆 칸)
 * - 회원·데모에게는 메뉴가 없음, 쓰기는 '확인함' 표시뿐(누를 때만 — 거르기·검색·탭·검사 칸을 써도 쓰기 0)
 * - 확인함 표시(ADR 0046 덧붙임 2026-11-28): 확인 필요 공지에만 메모 칸과 단추, 적으면 POST(메모는 있을 때만)·지우면 DELETE 뒤 요약 칸과 목록을 다시 읽음,
 *   확인 뒤 판정·사유가 바뀐 것은 그 사실과 그때의 메모
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    installedVersion: "9.9.9-0fake1", status: "check", reason: "DISTRO_NO_PENDING", otherFamily: false, basis: null },
    { aliasId: "linux-kernel", label: "Linux 커널", rowIndex: null, cve: null, rowProduct: null, source: "host", component: "kernel",
      installedVersion: "0.0.1-fake-generic", status: "patched", reason: null, otherFamily: false, basis: "CHANGELOG" }],
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
      // '확인 필요'는 남은 것만(ack=open — 손으로 확인해 둔 것은 '확인함' 거르기에).
      "/api/security/notices?verdict=check&ack=open&page=1&size=20",
      "/api/security/notices?verdict=check&reason=CONDITION_NOTE&ack=open&page=1&size=20",
      `/api/security/notices?verdict=check&reason=CONDITION_NOTE&ack=open&q=${encodeURIComponent("CVE-2099 & 가짜")}&page=1&size=20`,
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

describe("보안 공지 — 요약 칸", () => {
  it("제목을 고르면 그 공지를 읽어 판정·사유 한 줄과 이 환경에 걸린 것만 — 패치됨·무관은 줄 수 한 줄, 행 표 전체는 그리지 않음", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "[가짜] 합성 DB 보안 업데이트 권고" }));
    const dialog = await screen.findByRole("dialog", { name: "[가짜] 합성 DB 보안 업데이트 권고" });
    await within(dialog).findByText("이 환경에 걸린 것 2줄");
    expect(calledPaths()).toContain(endpoints.security.notice(900001));
    const items = within(dialog).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^주의: 해당PostgreSQLpostgres설치 판 postgresql 90\.2 · 해결 판 90\.5설치 판이 영향 구간 안$/),
      expect.stringMatching(/^확인 필요OpenSSL서버 호스트설치 판 libfake3 9\.9\.9-0fake1 · 해결 판 —배포판 패키지 — 보류 목록에 없음$/),
    ]);
    // 패치됨(커널 — 변경 기록)·무관(다른 계열 행)은 줄로 그리지 않고 수만.
    expect(within(dialog).getByText("패치됨 1개 · 무관 1개 — 목록은 ‘자세히 보기’에서 봅니다.")).toBeTruthy();
    expect(within(dialog).queryByText(/Linux 커널/)).toBeNull();
    expect(within(dialog).queryByText(/변경 기록에 CVE 있음/)).toBeNull();
    expect(within(dialog).queryByText(/다른 계열/)).toBeNull();
    expect(within(dialog).queryByText("90.0 이상 90.5 미만")).toBeNull();
    expect(within(dialog).queryByText(/^표 행/)).toBeNull();
    expect(within(dialog).queryByRole("table")).toBeNull();
    // ※ 조건 문장은 수와 첫 문장 한 줄(주의 아이콘 + 글).
    expect(within(dialog).getByText("※ 조건 문장 1개 — ※ 가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)")).toBeTruthy();

    const link = within(dialog).getByRole("link", { name: /원문 열기\(새 창\)/ });
    expect(link.getAttribute("href")).toBe("https://example.invalid/qa/900001");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    // '자세히 보기'는 팝업(2026-11-22 사용자 요청) — 요약 칸이 읽은 응답 그대로 상세 구역 ①~⑤를 넓은 대화상자에(다시 읽지 않음).
    const reads900001 = () => calledPaths().filter((path) => path === endpoints.security.notice(900001)).length;
    const before = reads900001();
    fireEvent.click(within(dialog).getByRole("button", { name: "자세히 보기" }));
    // 팝업이 열리면 바깥 요약 대화상자는 접근성 트리에서 가려집니다(Radix 모달) — 보이는 대화상자는 팝업 하나.
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    const popup = screen.getByRole("dialog", { name: "[가짜] 합성 DB 보안 업데이트 권고" });
    expect(within(popup).getByText(/^글 900001 · 게시 /)).toBeTruthy();
    expect(within(popup).getByText("공지 본문")).toBeTruthy();
    expect(within(popup).getAllByRole("table").length).toBeGreaterThan(0);
    expect(within(popup).getByRole("link", { name: /원문 열기\(새 창\)/ }).getAttribute("target")).toBe("_blank");
    expect(reads900001()).toBe(before);
  });

  // QA-1030: useApi는 다시 읽을 때 error를 비우고 failedAt을 남깁니다 — 처음 읽기 아님(큰 자리표시 없음)·오류 없음·값 없음이라 요약 칸이 아무것도
  // 그리지 않았습니다(같은 응답을 읽는 상세 화면 NoticeScreen은 이 경우를 읽는 중으로 그림 — 재현 커밋에서는 it.fails).
  it("QA-1030: 요약 칸 읽기가 실패한 뒤 '다시 시도'를 누르면 읽는 동안 빈 칸이 아니라 읽는 중 표시", async () => {
    let attempts = 0;
    api.apiGetShared.mockImplementation((path: string) => {
      if (path === endpoints.security.notice(900001)) {
        attempts += 1;
        return attempts === 1 ? Promise.reject(Object.assign(new Error("공지를 읽지 못했습니다(가짜 500)"), { status: 500 })) : new Promise(() => {});
      }
      return path in reads ? Promise.resolve(reads[path]) : new Promise(() => {});
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "[가짜] 합성 DB 보안 업데이트 권고" }));
    const dialog = await screen.findByRole("dialog", { name: "[가짜] 합성 DB 보안 업데이트 권고" });
    expect(await within(dialog).findByText("공지를 읽지 못했습니다(가짜 500)")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    await settled();

    expect(attempts).toBe(2);
    expect(within(dialog).queryByText("공지를 읽지 못했습니다(가짜 500)")).toBeNull();
    expect(within(dialog).getByRole("status", { name: "공지를 불러오는 중" })).toBeTruthy();
  });

  it("새 사유 DISTRO_OPEN은 '배포판 미수정', 추적기 칸이 있으면 고친 판이 해결 판으로, 걸린 것이 없으면 그 사실 한 줄", async () => {
    reads[endpoints.security.notice(900003)] = {
      ...DETAIL_900001,
      notice: { ...DETAIL_900001.notice, nttId: 900003, title: ITEMS[2].title, verdict: "check", reasons: ["DISTRO_OPEN"], conditionNotes: [] },
      rows: [],
      generalMatches: [{
        aliasId: "openssl", label: "OpenSSL", rowIndex: null, cve: null, rowProduct: null, source: "host", component: "libfake3",
        installedVersion: "9.9.9-0fake1", status: "check", reason: "DISTRO_OPEN", otherFamily: false, basis: null,
        tracker: { distro: "debian", suite: "fakesuite", cves: [
          { cve: "CVE-2099-90021", status: "open", fixedVersion: null, checkedAt: "2026-11-21T00:00:00Z" },
          { cve: "CVE-2099-90022", status: "fixed", fixedVersion: "9.9.9-0fake3", checkedAt: "2026-11-21T00:00:00Z" },
        ] },
      }],
    };
    reads[endpoints.security.notice(900002)] = {
      ...DETAIL_900001,
      notice: { ...DETAIL_900001.notice, nttId: 900002, title: ITEMS[1].title, verdict: "patched", reasons: [], conditionNotes: [] },
      rows: [],
      generalMatches: [DETAIL_900001.generalMatches[1]],
    };
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: ITEMS[2].title }));
    const dialog = await screen.findByRole("dialog", { name: ITEMS[2].title });
    await within(dialog).findByText("이 환경에 걸린 것 1줄");
    expect(within(dialog).getAllByText("배포판 미수정").length).toBe(2);
    expect(within(dialog).getByRole("listitem").textContent).toContain("해결 판 9.9.9-0fake3");
    expect(within(dialog).queryByText("DISTRO_OPEN")).toBeNull();
    expect(within(dialog).queryByText(/조건 문장/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /닫기/ }));
    await settled();

    fireEvent.click(screen.getByRole("button", { name: ITEMS[1].title }));
    const patched = await screen.findByRole("dialog", { name: ITEMS[1].title });
    await within(patched).findByText("이 환경에 걸린 것 0줄");
    expect(within(patched).getByText("해당·확인 필요인 근거가 없습니다.")).toBeTruthy();
    expect(within(patched).getByText("패치됨 1개 · 무관 0개 — 목록은 ‘자세히 보기’에서 봅니다.")).toBeTruthy();
    expect(within(patched).getByRole("button", { name: "자세히 보기" })).toBeTruthy();
  });

  it("알림함 링크 ?ntt=<번호>는 그 공지의 요약 칸을 연다 — 좁은 화면은 대화상자", async () => {
    nav.search = "?ntt=900001";
    await renderPage();
    const dialog = await screen.findByRole("dialog", { name: "[가짜] 합성 DB 보안 업데이트 권고" });
    await within(dialog).findByText("이 환경에 걸린 것 2줄");
    expect(within(dialog).getByRole("button", { name: "자세히 보기" })).toBeTruthy();
  });

  it("?ntt=의 공지가 지금 쪽에 없어도 연다(제목 '보안 공지 <번호>'), 숫자가 아니면 열지 않는다", async () => {
    reads[endpoints.security.notice(900099)] = { ...DETAIL_900001, notice: { ...DETAIL_900001.notice, nttId: 900099, title: "[가짜] 지난 공지" } };
    nav.search = "?ntt=900099";
    await renderPage();
    const dialog = await screen.findByRole("dialog", { name: "보안 공지 900099" });
    await within(dialog).findByText("이 환경에 걸린 것 2줄");
    expect(within(dialog).getByRole("button", { name: "자세히 보기" })).toBeTruthy();
    cleanup();

    nav.search = "?ntt=abc";
    await renderPage();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("넓은 화면은 ?ntt=의 공지를 옆 요약 칸에 고른다(표의 그 행이 고른 행) — 같은 요약", async () => {
    stubWide();
    nav.search = "?ntt=900001";
    await renderPage();
    const inspector = await screen.findByRole("region", { name: "보안 공지 — [가짜] 합성 DB 보안 업데이트 권고" });
    await within(inspector).findByText("이 환경에 걸린 것 2줄");
    expect(within(inspector).getByText("패치됨 1개 · 무관 1개 — 목록은 ‘자세히 보기’에서 봅니다.")).toBeTruthy();
    expect(within(inspector).queryByRole("table")).toBeNull();
    expect(within(inspector).getByRole("button", { name: "자세히 보기" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowOf("[가짜] 합성 DB 보안 업데이트 권고").getAttribute("aria-current")).toBeTruthy();
  });
});

describe("보안 공지 — 메뉴와 쓰기", () => {
  it("운영자에게만 메뉴(더보기 '묶음 없음'의 글자순 — 데이터 저장소 상태 다음) — 회원·데모·모르는 사용자에게는 없음", () => {
    const more = TABS.find((tab) => tab.key === "more")!;
    const owner = visibleItems(more, OWNER).map((entry) => entry.href);
    expect(owner.indexOf("/security")).toBe(owner.indexOf("/status") + 1);
    expect(more.items.find((entry) => entry.href === "/security")).toMatchObject({ label: "보안 공지" });
    for (const user of [MEMBER, DEMO, undefined]) {
      expect(visibleItems(more, user).map((entry) => entry.href)).not.toContain("/security");
      expect(navSearchItems(user).map((entry) => entry.href)).not.toContain("/security");
    }
  });

  it("거르기·검색·탭·검사 칸을 써도 POST·DELETE 0 — 쓰기는 '확인함' 단추를 누를 때만", async () => {
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

// ------------------------------------------------------------------ 확인함 표시(ADR 0046 덧붙임 2026-11-28)
const CHECK_TITLE = "[가짜] 합성 언어 보안 업데이트 권고";

function checkDetail(ack: Record<string, unknown> | null) {
  return {
    available: true, checkedAt: "2026-11-21T01:00:00Z", inventory: INVENTORY,
    notice: {
      ...ITEMS[2], ack, listNo: 99003, firstSeenAt: "2026-11-20T03:00:00Z", detailFetchedAt: "2026-11-20T03:00:10Z", detailAttempts: 1, detailError: null,
      noticeProducts: ["Python"], notes: [], conditionNotes: [], bodyText: "가짜 본문",
    },
    rows: [],
    generalMatches: [],
  };
}

describe("보안 공지 — 확인함 표시", () => {
  it("확인 필요 공지의 요약 칸에 메모 칸과 '확인함으로 표시' — 누르면 POST(메모는 앞뒤 공백을 떼어), 그 뒤 요약 칸과 목록을 다시 읽어 확인한 시각·메모와 '확인 취소'", async () => {
    reads[endpoints.security.notice(900003)] = checkDetail(null);
    api.apiPost.mockImplementation(() => {
      reads[endpoints.security.notice(900003)] = checkDetail({
        ackedAt: "2026-11-21T01:30:00Z", note: "가짜 근거 한 줄", valid: true, verdict: "check", reasons: ["CONDITION_NOTE"],
      });
      return Promise.resolve({});
    });
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: CHECK_TITLE }));
    const dialog = await screen.findByRole("dialog", { name: CHECK_TITLE });
    const memo = await within(dialog).findByLabelText("확인 메모(선택)");
    expect((memo as HTMLTextAreaElement).maxLength).toBe(500);
    expect(api.apiPost).not.toHaveBeenCalled();
    const listReads = () => calledPaths().filter((path) => path === LIST).length;
    const before = listReads();

    fireEvent.change(memo, { target: { value: "  가짜 근거 한 줄  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "확인함으로 표시" }));
    await settled();

    expect(api.apiPost.mock.calls).toEqual([[endpoints.security.noticeAck("900003"), { note: "가짜 근거 한 줄" }]]);
    expect(await within(dialog).findByText("확인함 · 2026-11-21 10:30")).toBeTruthy();
    expect(within(dialog).getByText("메모: 가짜 근거 한 줄")).toBeTruthy();
    expect(within(dialog).queryByLabelText("확인 메모(선택)")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "확인 취소" })).toBeTruthy();
    expect(listReads()).toBe(before + 1);
  });

  it("메모 없이도 확인할 수 있고(본문 {}), '확인 취소'는 DELETE — 실패하면 그 문구를 보이고 다시 읽지 않는다", async () => {
    reads[endpoints.security.notice(900003)] = checkDetail(null);
    api.apiPost.mockResolvedValue({});
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: CHECK_TITLE }));
    const dialog = await screen.findByRole("dialog", { name: CHECK_TITLE });
    fireEvent.click(await within(dialog).findByRole("button", { name: "확인함으로 표시" }));
    await settled();
    expect(api.apiPost.mock.calls).toEqual([[endpoints.security.noticeAck("900003"), {}]]);

    cleanup();
    reads[endpoints.security.notice(900003)] = checkDetail({ ackedAt: "2026-11-21T01:30:00Z", note: null, valid: true, verdict: "check", reasons: ["CONDITION_NOTE"] });
    api.apiDelete.mockRejectedValue(new Error("가짜 실패 문구"));
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: CHECK_TITLE }));
    const again = await screen.findByRole("dialog", { name: CHECK_TITLE });
    const noticeReads = () => calledPaths().filter((path) => path === endpoints.security.notice(900003)).length;
    fireEvent.click(await within(again).findByRole("button", { name: "확인 취소" }));
    const before = noticeReads();
    await settled();
    expect(api.apiDelete.mock.calls).toEqual([[endpoints.security.noticeAck("900003")]]);
    expect(within(again).getByText("가짜 실패 문구")).toBeTruthy();
    expect(noticeReads()).toBe(before);
  });

  it("확인한 뒤 판정·사유가 바뀐 공지는 그 사실과 그때의 사유·메모를 보이고 다시 확인할 수 있다 — 목록에는 '확인함'·'확인 뒤 바뀜' 표지", async () => {
    const stale = { ackedAt: "2026-11-20T01:30:00Z", note: "예전 가짜 메모", valid: false, verdict: "check", reasons: ["NAME_MATCH"] };
    reads[LIST] = noticesResponse({
      items: [
        ITEMS[0],
        { ...ITEMS[1], verdict: "check", ack: { ...stale, valid: true } },
        { ...ITEMS[2], ack: stale },
        ITEMS[3],
      ],
    });
    reads[endpoints.security.notice(900003)] = checkDetail(stale);
    await renderPage();
    expect(within(rowOf("[가짜] 합성 런타임 보안 업데이트 권고")).getByText("확인함")).toBeTruthy();
    expect(within(rowOf(CHECK_TITLE)).getByText("확인 뒤 바뀜")).toBeTruthy();
    expect(within(rowOf("[가짜] 합성 DB 보안 업데이트 권고")).queryByText("확인함")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: CHECK_TITLE }));
    const dialog = await screen.findByRole("dialog", { name: CHECK_TITLE });
    expect(await within(dialog).findByText("확인한 뒤 판정이나 사유가 바뀌었습니다")).toBeTruthy();
    expect(within(dialog).getByText("2026-11-20 10:30에 확인할 때는 확인 필요(이름만 맞음)였습니다. 그때 메모: 예전 가짜 메모")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "확인함으로 표시" })).toBeTruthy();
  });

  it("확인 필요가 아닌 공지(해당)에는 확인함 칸이 없다", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "[가짜] 합성 DB 보안 업데이트 권고" }));
    const dialog = await screen.findByRole("dialog", { name: "[가짜] 합성 DB 보안 업데이트 권고" });
    await within(dialog).findByText("이 환경에 걸린 것 2줄");
    expect(within(dialog).queryByRole("button", { name: "확인함으로 표시" })).toBeNull();
    expect(within(dialog).queryByLabelText("확인 메모(선택)")).toBeNull();
  });
});
