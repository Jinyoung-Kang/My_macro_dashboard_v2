/**
 * 보안 공지 상세(/security/<번호> — ADR 0046, 운영자 전용·읽기만). 응답은 모두 가짜 값입니다(글 번호 9000xx, CVE-2099-*, 실제로 없는 큰 버전·가짜 배포판
 * 코드명 — 실제 서버 버전·공지 원문 아님).
 * - 머리: 제목 h1·종류 '보안 공지'·글 번호·판정(아이콘 + 글)·사유, '목록으로'(/security)·'원문 열기(새 창)'
 * - ① 이 환경 판정: 해당·확인 필요 줄만 표에, 패치됨·무관은 건수를 적은 접기 안(기본 접힘)
 * - ③ 공지 표: 기본 '이 스택 행만', '전체'로 바꾸면 모든 행
 * - ④ 추적기: 있으면 CVE마다 상태·고친 판·확인 시각과 추적기 링크(새 창), 옛 응답(칸 없음)이면 그리지 않음
 * - 새 사유 DISTRO_OPEN의 글, 본문은 접힘, 한계 한 줄
 * - 번호가 틀리면 읽지 않고 안내 + 목록으로, 없는 번호(404)·그 밖의 실패
 * - 이 화면은 GET 한 번(쓰기 0), 셸에 공지 제목을 넘김(빵부스러기·탭 제목)
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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/security/900001",
  useSearchParams: () => new URLSearchParams(""),
}));

import { resetEntityCrumbForTest, useEntityCrumbLabel } from "@/hooks/useEntityCrumb";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";
import SecurityNoticePage from "../security/[nttId]/page";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO", local: false };

const INVENTORY = {
  collectedAt: "2026-11-20T15:00:00Z", receivedAt: "2026-11-20T15:00:05Z", ageSeconds: 36_000, stale: false,
  hostIncluded: true, aptListsAt: "2026-11-20T12:00:00Z", notOkSections: [],
};

type Json = Record<string, unknown>;

function matchOf(over: Json): Json {
  return {
    aliasId: "postgres", label: "PostgreSQL", rowIndex: null, cve: null, rowProduct: null, source: "postgres", component: "postgresql",
    installedVersion: "90.2", status: "check", reason: null, otherFamily: false, basis: null, ...over,
  };
}

const TRACKER = {
  distro: "ubuntu", suite: "fakesuite",
  cves: [
    { cve: "CVE-2099-90011", status: "fixed", fixedVersion: "9.9.9-0fake2", checkedAt: "2026-11-21T00:00:00Z" },
    { cve: "CVE-2099-90012", status: "open", fixedVersion: null, checkedAt: "2026-11-21T00:00:00Z" },
  ],
};

/** 가짜 공지 한 건 — PostgreSQL 해당(행), 다른 계열 행(무관), 이 스택 밖 제품 행, OpenSSL 배포판 미수정(추적기)·커널 패치됨(변경 기록). */
function detail(over: { notice?: Json; generalMatches?: Json[]; rows?: Json[] } = {}) {
  return {
    available: true, checkedAt: "2026-11-21T01:00:00Z", inventory: INVENTORY,
    notice: {
      nttId: 900001, title: "[가짜] 합성 DB 보안 업데이트 권고", postedOn: "2026-11-20", url: "https://example.invalid/qa/900001", pinned: false,
      detailStatus: "ok", layout: "product_table", verdict: "affected", reasons: ["DISTRO_OPEN"], conditionNote: true,
      products: [], rowCount: 3, cveCount: 3, listNo: 99001, firstSeenAt: "2026-11-20T03:00:00Z", detailFetchedAt: "2026-11-20T03:00:10Z",
      detailAttempts: 1, detailError: null, noticeProducts: ["PostgreSQL", "가짜 다른 제품"],
      notes: ["※ 가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)"], conditionNotes: ["※ 가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)"],
      bodyText: "가짜 본문 첫 줄\n가짜 본문 둘째 줄",
      ...over.notice,
    },
    rows: over.rows ?? [
      {
        index: 0, cve: "CVE-2099-90001", product: "PostgreSQL", affected: "90.0 이상 90.5 미만", fixed: "90.5",
        aliases: [{ aliasId: "postgres", label: "PostgreSQL" }], status: "affected", reasons: [],
        matches: [matchOf({ rowIndex: 0, cve: "CVE-2099-90001", rowProduct: "PostgreSQL", status: "affected" })],
      },
      {
        index: 1, cve: "CVE-2099-90002", product: "PostgreSQL", affected: "89.0 이상 89.9 미만", fixed: "89.9",
        aliases: [{ aliasId: "postgres", label: "PostgreSQL" }], status: "unrelated", reasons: [],
        matches: [matchOf({ rowIndex: 1, cve: "CVE-2099-90002", rowProduct: "PostgreSQL", status: "unrelated", otherFamily: true })],
      },
      {
        index: 2, cve: "CVE-2099-90003", product: "가짜 다른 제품", affected: "1.0 미만", fixed: "1.0",
        aliases: [], status: "unrelated", reasons: [], matches: [],
      },
    ],
    generalMatches: over.generalMatches ?? [
      matchOf({ aliasId: "openssl", label: "OpenSSL", source: "host", component: "libfake3", installedVersion: "9.9.9-0fake1", reason: "DISTRO_OPEN", tracker: TRACKER }),
      matchOf({ aliasId: "linux-kernel", label: "Linux 커널", source: "host", component: "kernel", installedVersion: "0.0.1-fake-generic", status: "patched", basis: "CHANGELOG" }),
    ],
  };
}

const NOTICE = endpoints.security.notice(900001);
let reads: Record<string, unknown> = {};
let failures: Record<string, { message: string; status: number }> = {};

beforeEach(() => {
  reads = { [NOTICE]: detail() };
  failures = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path in failures) return Promise.reject(Object.assign(new Error(failures[path].message), { status: failures[path].status }));
    return path in reads ? Promise.resolve(reads[path]) : new Promise(() => {});
  });
  resetEntityCrumbForTest();
});
afterEach(() => cleanup());

async function settled() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}
const calledPaths = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);

/** 셸이 읽는 대상 이름(빵부스러기·탭 제목). */
function CrumbProbe() {
  const crumb = useEntityCrumbLabel();
  return <output data-testid="crumb">{crumb ? `${crumb.href} ${crumb.label}` : ""}</output>;
}

async function renderPage(nttId = "900001") {
  const element = await SecurityNoticePage({ params: Promise.resolve({ nttId }) });
  render(
    <SessionUserProvider user={OWNER}>
      {element}
      <CrumbProbe />
    </SessionUserProvider>,
  );
  await settled();
}

const panel = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;

describe("보안 공지 상세 — 머리", () => {
  it("제목 h1·종류 태그·글 번호·판정(아이콘 + 글)·사유, '목록으로'와 '원문 열기(새 창)', 셸에 제목을 넘김", async () => {
    await renderPage();
    const header = screen.getByRole("heading", { level: 1, name: "[가짜] 합성 DB 보안 업데이트 권고" }).closest("header") as HTMLElement;
    expect(within(header).getByText("보안 공지")).toBeTruthy();
    expect(within(header).getByText("글 900001")).toBeTruthy();
    expect(within(header).getByText("게시 2026-11-20 · 제품 버전 표 · 상세 받음 2026-11-20 12:00")).toBeTruthy();
    const verdict = within(header).getByText("해당");
    expect(verdict.closest("span.inline-flex")?.querySelector("svg")).toBeTruthy();
    expect(within(header).getByText("배포판 미수정")).toBeTruthy();
    expect(within(header).getByRole("link", { name: "목록으로" }).getAttribute("href")).toBe("/security");
    const original = within(header).getByRole("link", { name: /원문 열기\(새 창\)/ });
    expect(original.getAttribute("href")).toBe("https://example.invalid/qa/900001");
    expect(original.getAttribute("target")).toBe("_blank");
    expect(original.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByTestId("crumb").textContent).toBe("/security/900001 [가짜] 합성 DB 보안 업데이트 권고");
    expect(calledPaths()).toEqual([NOTICE]);
  });
});

describe("보안 공지 상세 — ① 이 환경 판정", () => {
  it("해당·확인 필요 줄만 표에, 패치됨·무관은 건수를 적은 접기 안(기본 접힘)", async () => {
    await renderPage();
    const section = panel("이 환경 판정");
    const exposed = within(section).getByRole("table", { name: "이 환경에 걸린 것" });
    const bodyRows = within(exposed).getAllByRole("row").slice(1);
    expect(bodyRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("PostgreSQL"),
      expect.stringContaining("OpenSSL"),
    ]);
    expect(bodyRows[0].textContent).toContain("주의: 해당");
    expect(bodyRows[0].textContent).toContain("postgresql 90.2");
    expect(bodyRows[0].textContent).toContain("90.5");
    expect(bodyRows[0].textContent).toContain("설치 판이 영향 구간 안");
    expect(bodyRows[1].textContent).toContain("확인 필요");
    expect(bodyRows[1].textContent).toContain("서버 호스트");
    expect(bodyRows[1].textContent).toContain("libfake3 9.9.9-0fake1");
    expect(bodyRows[1].textContent).toContain("9.9.9-0fake2");
    expect(bodyRows[1].textContent).toContain("배포판 미수정");
    expect(exposed.textContent).not.toContain("Linux 커널");
    expect(exposed.textContent).not.toContain("다른 계열 행");

    const patched = within(section).getByText("패치됨 1개").closest("details") as HTMLDetailsElement;
    const unrelated = within(section).getByText("무관 1개").closest("details") as HTMLDetailsElement;
    expect(patched.open).toBe(false);
    expect(unrelated.open).toBe(false);
    expect(within(patched).getByRole("table", { hidden: true, name: "패치됨" }).textContent).toContain("변경 기록에 CVE 있음");
    expect(within(unrelated).getByRole("table", { hidden: true, name: "무관" }).textContent).toContain("다른 계열 행");
    expect(within(section).getByText(/^배포판 미수정: 배포판 보안 추적기에 아직 고치지 않음으로 적혀 있습니다/)).toBeTruthy();
  });

  it("걸린 것이 없으면 표의 빈 글, 패치됨만 있으면 그 접기 하나", async () => {
    reads[NOTICE] = detail({
      notice: { verdict: "patched", reasons: [], conditionNotes: [], notes: [] },
      rows: [],
      generalMatches: [matchOf({ aliasId: "linux-kernel", label: "Linux 커널", source: "host", component: "kernel", status: "patched", basis: "TRACKER" })],
    });
    await renderPage();
    const section = panel("이 환경 판정");
    expect(within(section).getByText("해당·확인 필요인 근거가 없습니다.")).toBeTruthy();
    expect(within(section).getByText("패치됨 1개")).toBeTruthy();
    expect(within(section).queryByText(/^무관 /)).toBeNull();
    expect(screen.queryByText(/표 밖 조건 문장/)).toBeNull();
    expect(within(panel("공지 표")).getByText("이 공지에는 제품 버전 표가 없습니다(표 틀: 제품 버전 표).")).toBeTruthy();
  });
});

describe("보안 공지 상세 — ② 조건 문장 · ③ 공지 표", () => {
  it("※ 조건 문장은 안내 상자에 전부", async () => {
    await renderPage();
    expect(screen.getByText("표 밖 조건 문장(※) 1개")).toBeTruthy();
    expect(screen.getByText("※ 가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)")).toBeTruthy();
  });

  it("기본 '이 스택 행만'(이 스택 제품이 붙은 행) — '전체'로 바꾸면 모든 행", async () => {
    await renderPage();
    const section = panel("공지 표");
    const scope = within(section).getByRole("radiogroup", { name: "공지 표 범위" });
    expect(within(scope).getByRole("radio", { name: /이 스택 행만/ }).getAttribute("aria-checked")).toBe("true");
    expect(within(section).getByRole("table", { name: "공지 표 — 이 스택 행" }).textContent).not.toContain("가짜 다른 제품");
    expect(within(section).getAllByRole("row")).toHaveLength(3);

    fireEvent.click(within(scope).getByRole("radio", { name: /전체/ }));
    const all = within(section).getByRole("table", { name: "공지 표 — 전체" });
    expect(within(all).getAllByRole("row")).toHaveLength(4);
    expect(all.textContent).toContain("가짜 다른 제품");
    expect(all.textContent).toContain("89.0 이상 89.9 미만");
  });
});

describe("보안 공지 상세 — ④ 추적기 · ⑤ 본문", () => {
  it("추적기 근거가 있으면 CVE마다 상태(아이콘 + 글)·고친 판·확인 시각과 추적기 링크(새 창)", async () => {
    await renderPage();
    const section = panel("배포판 보안 추적기");
    expect(within(section).getByText("OpenSSL · 서버 호스트 · libfake3 9.9.9-0fake1 · Ubuntu fakesuite")).toBeTruthy();
    const link = within(section).getByRole("link", { name: /CVE-2099-90011/ });
    expect(link.getAttribute("href")).toBe("https://ubuntu.com/security/CVE-2099-90011");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const table = within(section).getByRole("table");
    expect(table.textContent).toContain("고침");
    expect(table.textContent).toContain("주의: 아직 고치지 않음");
    expect(table.textContent).toContain("9.9.9-0fake2");
    expect(table.textContent).toContain("2026-11-21 09:00");
  });

  it("옛 서버 응답(tracker·basis 칸 없음)이면 추적기 칸을 그리지 않는다", async () => {
    reads[NOTICE] = detail({
      generalMatches: [{ aliasId: "openssl", label: "OpenSSL", rowIndex: null, cve: null, rowProduct: null, source: "host", component: "libfake3",
        installedVersion: "9.9.9-0fake1", status: "check", reason: "DISTRO_NO_PENDING", otherFamily: false }],
    });
    await renderPage();
    expect(screen.queryByRole("heading", { name: "배포판 보안 추적기" })).toBeNull();
    expect(within(panel("이 환경 판정")).getByText("배포판 패키지 — 보류 목록에 없음")).toBeTruthy();
  });

  it("본문은 접힘(글자 수 표시), 한계 한 줄은 늘", async () => {
    await renderPage();
    const fold = within(panel("공지 본문")).getByText(/^본문 펼치기\(\d+자\)$/).closest("details") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(screen.getByText(/보호나라는 이 스택의 일부만 다룹니다/)).toBeTruthy();
  });
});

describe("보안 공지 상세 — 상태", () => {
  it("번호가 숫자가 아니면 읽지 않고 안내와 '목록으로'", async () => {
    await renderPage("abc");
    expect(screen.getByText("공지 번호가 올바르지 않습니다")).toBeTruthy();
    expect(screen.getByRole("link", { name: "목록으로" }).getAttribute("href")).toBe("/security");
    expect(calledPaths()).toEqual([]);
  });

  it("없는 번호(404)는 '찾지 못함'과 '목록으로', 그 밖의 실패는 오류와 다시 시도", async () => {
    failures[NOTICE] = { message: "없는 공지입니다", status: 404 };
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "보안 공지 900001" })).toBeTruthy();
    expect(screen.getByText("이 번호의 공지를 찾지 못했습니다")).toBeTruthy();
    expect(screen.getByRole("link", { name: "목록으로" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    cleanup();

    failures[NOTICE] = { message: "요청 실패 (HTTP 503)", status: 503 };
    await renderPage();
    expect(screen.getByText("요청 실패 (HTTP 503)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "목록으로" })).toBeTruthy();
  });

  it("이 화면은 GET만 — 범위를 바꾸고 접기를 열어도 쓰기 0", async () => {
    await renderPage();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "공지 표 범위" })).getByRole("radio", { name: /전체/ }));
    fireEvent.click(screen.getByText("패치됨 1개"));
    await settled();
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(api.apiDelete).not.toHaveBeenCalled();
    expect(api.apiGet).not.toHaveBeenCalled();
    expect(calledPaths()).toEqual([NOTICE]);
  });
});
