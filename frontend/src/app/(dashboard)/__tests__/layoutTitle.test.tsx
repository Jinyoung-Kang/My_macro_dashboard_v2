/**
 * QA-565: 브라우저 탭 제목(useDocumentTitle)이 Next 루트 metadata의 <title>에 덮여 'Global Macro & 13F Dashboard'로 남았습니다.
 *
 * 루트 레이아웃(app/layout.tsx)의 metadata.title은 React 19의 hoistable <title>로 그려집니다. 이 <title>이 대시보드 레이아웃의 첫 effect보다 늦은
 * 커밋에서 문서의 첫 <title>을 차지하며 글을 루트 제목으로 다시 씁니다(QA 스택 추적 — 앱 effect가 메뉴 제목을 쓴 4~15ms 뒤). 효과가 [pathname, unread]가
 * 바뀔 때만 다시 돌아, 그 뒤 읽지 않은 알림 수 요청이 실패하면(null 그대로) 늘, 응답이 덮어쓰기보다 먼저 오면 경합으로 루트 제목이 남았습니다.
 * 클라이언트 이동 뒤에는 바로잡혔습니다. metadata.title·APP_TITLE은 그대로 둡니다(QA-270 사용자 결정).
 *
 * jsdom에서는 서버 HTML의 <title>을 head에 넣어 두고, 메뉴 제목이 된 뒤 그 글 노드를 루트 제목으로 덮어써 React의 늦은 커밋을 흉내 냅니다.
 * 목 구성(api·next/navigation usePathname — 기본 '/macro')은 layoutSession.test.tsx와 같습니다.
 *
 * QA-594: 상세 화면(지표·종목·기관)의 탭 제목에 대상 이름이 없어(지표·종목 상세는 모두 '시장 · 매크로 대시보드', 기관 상세는 목록과 같은 '13F 포트폴리오 ·
 * 매크로 대시보드') 상세 탭 여러 개를 제목으로 구분할 수 없었습니다. 빵부스러기 마지막 칸과 같은 글(상세 화면이 넘긴 이름 — hooks/useEntityCrumb, 받기 전은
 * 주소의 식별자)을 제목 앞에 붙입니다. 시험의 CIK는 늘 10자리입니다.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionResponse } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiGetShared: vi.fn(),
    apiBase: () => "",
    UnauthorizedError,
    auth: { logout: vi.fn() },
  };
});
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const nav = vi.hoisted(() => ({ pathname: "/macro" }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => nav.pathname }));

import { resetEntityCrumbForTest, useEntityCrumb } from "@/hooks/useEntityCrumb";
import DashboardLayout from "../layout";

const SESSION = "/api/auth/session";
const UNREAD = "/api/alerts/unread-count";

const ROOT_TITLE = "Global Macro & 13F Dashboard";
const MACRO_TITLE = "매크로 지표 · 매크로 대시보드";

const LOCAL_OWNER: SessionResponse = {
  authenticated: true,
  readMode: "auto",
  noLogin: true,
  user: { email: "owner@test.local", role: "OWNER", tier: "PRO", local: true },
};

/** 경로별 응답. 없는 경로는 끝나지 않습니다. */
let reads: Record<string, unknown>;

function serve(path: string): Promise<unknown> {
  if (!(path in reads)) return new Promise(() => {});
  const value = reads[path];
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

/** React 19가 루트 metadata의 <title>을 늦게 커밋하며 글을 다시 쓰는 것 — 문서의 첫 <title>의 글 노드를 루트 제목으로 덮어씁니다. */
function overwriteWithRootTitle(): void {
  const node = document.head.querySelector("title")?.firstChild;
  if (!node) throw new Error("<title>의 글 노드가 없습니다");
  node.nodeValue = ROOT_TITLE;
}

function renderLayout() {
  return render(
    <DashboardLayout>
      <p>대시보드 본문</p>
    </DashboardLayout>,
  );
}

beforeEach(() => {
  // 서버 HTML이 그린 루트 metadata의 <title>.
  document.head.insertAdjacentHTML("beforeend", "<title>Global Macro &amp; 13F Dashboard</title>");
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  router.replace.mockReset();
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
  for (const title of document.head.querySelectorAll("title")) title.remove();
  nav.pathname = "/macro";
  act(() => resetEntityCrumbForTest());
});

describe("QA-565 — 탭 제목이 루트 metadata의 <title>에 덮여도 메뉴 제목으로 돌아온다", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 덮어쓴 뒤 'Global Macro & 13F Dashboard'에 머묾 — unread가 실패(null 그대로)라 효과가 다시 돌지 않음.
  it("읽지 않은 알림 수 요청이 실패해도(500) 덮어쓴 뒤 '매크로 지표 · 매크로 대시보드'로 돌아온다", async () => {
    reads = { [SESSION]: LOCAL_OWNER, [UNREAD]: new Error("500") };
    renderLayout();
    await waitFor(() => expect(document.title).toBe(MACRO_TITLE));

    await act(async () => overwriteWithRootTitle());
    await waitFor(() => expect(document.title).toBe(MACRO_TITLE));
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 덮어쓴 뒤 'Global Macro & 13F Dashboard'에 머묾 — 응답이 덮어쓰기보다 먼저 와 효과가 다시 돌지 않음.
  it("읽지 않은 알림이 3건이면 덮어쓴 뒤 '(3) 매크로 지표 · 매크로 대시보드'로 돌아온다", async () => {
    reads = { [SESSION]: LOCAL_OWNER, [UNREAD]: { unread: 3 } };
    renderLayout();
    await waitFor(() => expect(document.title).toBe(`(3) ${MACRO_TITLE}`));

    await act(async () => overwriteWithRootTitle());
    await waitFor(() => expect(document.title).toBe(`(3) ${MACRO_TITLE}`));
  });
});

const INSTITUTION = "/institutions/0001608046";
const NPS = "국민연금 (National Pension Service)";
const NPS_TITLE = `${NPS} · 13F 포트폴리오 · 매크로 대시보드`;

/** 기관 상세 화면 대역 — 읽은 이름을 셸에 넘깁니다(InstitutionDetailScreen과 같은 훅). */
function InstitutionScreen({ href = INSTITUTION }: { href?: string }) {
  useEntityCrumb(href, NPS);
  return <p>기관 상세</p>;
}

function renderAt(pathname: string, child: ReactNode) {
  nav.pathname = pathname;
  return render(<DashboardLayout>{child}</DashboardLayout>);
}

describe("QA-594 — 상세 화면 탭 제목에 대상 이름(빵부스러기 마지막 칸과 같은 글)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 이름을 받아도 '13F 포트폴리오 · 매크로 대시보드'(기관 목록과 같은 제목)였습니다.
  it.fails("기관 상세가 이름을 넘기면 '국민연금 (National Pension Service) · 13F 포트폴리오 · 매크로 대시보드' — 루트 제목에 덮여도 그 제목으로 돌아온다", async () => {
    reads = { [SESSION]: LOCAL_OWNER, [UNREAD]: new Error("500") };
    renderAt(INSTITUTION, <InstitutionScreen />);
    await waitFor(() => expect(document.title).toBe(NPS_TITLE));

    await act(async () => overwriteWithRootTitle());
    await waitFor(() => expect(document.title).toBe(NPS_TITLE));
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 '(3) 13F 포트폴리오 · 매크로 대시보드'였습니다.
  it.fails("읽지 않은 알림이 3건이면 '(3) 국민연금 (National Pension Service) · 13F 포트폴리오 · 매크로 대시보드'", async () => {
    reads = { [SESSION]: LOCAL_OWNER, [UNREAD]: { unread: 3 } };
    renderAt(INSTITUTION, <InstitutionScreen />);
    await waitFor(() => expect(document.title).toBe(`(3) ${NPS_TITLE}`));
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 'CIK …' 없이 '13F 포트폴리오 · 매크로 대시보드'였습니다.
  it.fails("이름을 받기 전·다른 주소의 이름이면 빵부스러기처럼 주소의 식별자 — 'CIK 0001608046 · 13F 포트폴리오 · 매크로 대시보드'", async () => {
    reads = { [SESSION]: LOCAL_OWNER, [UNREAD]: new Error("500") };
    renderAt(INSTITUTION, <InstitutionScreen href="/institutions/0001767640" />);
    await waitFor(() => expect(document.title).toBe("CIK 0001608046 · 13F 포트폴리오 · 매크로 대시보드"));
  });

  it("목록 화면·모의매매 탭은 대상 칸이 없어 메뉴 제목 그대로 — 남아 있는 이름을 붙이지 않는다", async () => {
    reads = { [SESSION]: LOCAL_OWNER, [UNREAD]: new Error("500") };
    renderAt("/institutions", <InstitutionScreen />);
    await waitFor(() => expect(document.title).toBe("13F 포트폴리오 · 매크로 대시보드"));
    cleanup();
    renderAt("/paper/us/holdings", <InstitutionScreen href="/paper/us/holdings" />);
    await waitFor(() => expect(document.title).toBe("모의매매(미국) · 매크로 대시보드"));
  });
});
