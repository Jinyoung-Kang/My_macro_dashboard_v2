/**
 * 기관 상세 '상위 보유 종목' 머리의 '13F 포트폴리오에서 자세히' 링크 — 좁은 화면(lg 미만) 누르는 자리 44px와 포커스 링(QA-531).
 * 응답은 모두 합성 값입니다(가상 기관 이름·CIK).
 *
 * D1 QA 스택 확인(`touch-targets-lt-lg-missed-by-qa458`)에서 이 링크가 390에서 글 높이(16px)뿐이었습니다 — QA-458 고침과 화면 DOM 감사가 덮지
 * 않은 자리(그 시험은 기관 상세를 그리지 않음). 따로 선 링크라 문장 안 예외(WCAG 2.5.8)도 아닙니다. 포커스 링(focus-visible 바깥선)도 없어
 * 키보드로 옮기면 어디 있는지 보이지 않았습니다. 높이는 클래스로 따집니다(lib/__tests__/touchTargetAudit — jsdom은 배치를 재지 않음).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { belowLgTarget } from "@/lib/__tests__/touchTargetAudit";
import type { PortfolioResponse, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { InstitutionDetailScreen } from "../InstitutionDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const CIK = "0009999997";

const BODY: PortfolioResponse = {
  available: true,
  cik: CIK,
  institution: { name: "🇺🇸 가상 연기금 (Fictional Pension)", desc: "" },
  collectedAtKst: "2026-11-15 09:00 KST",
  ageSeconds: 60,
  quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 1_000_000_000, holdingCount: 1 }],
  latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1_000_000_000 },
  holdings: [{ name: "SYNTHETIC CO", cusip: "000000001", class: "COM", value: 1_000_000_000, shares: 1_000, weight: 100, weightDiff: null, sharesDiff: null, action: "유지" }],
};

/** 요소의 클래스 낱말. */
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.institution.portfolio(CIK, 8, 30) ? Promise.resolve(BODY) : new Promise(() => {}),
  );
});
afterEach(cleanup);

describe("기관 상세 — '13F 포트폴리오에서 자세히' 링크의 누르는 자리(QA-531)", () => {
  // QA-531: 링크 클래스가 'rounded-sm text-xs font-medium text-text underline-offset-2 hover:underline'뿐이라 lg 미만 높이 클래스가 없고
  // (글 높이 16px) 포커스 링도 없었습니다.
  // 수정 전 실패: belowLgTarget(링크 클래스)이 'lg 미만 44px 높이 클래스(min-h-11 등) 없음'(재현 커밋에서는 it.fails).
  // 고침: 링크에 TEXT_TARGET(lg 미만 min-h-11, lg 이상 글 높이)과 FOCUS_RING.
  it("좁은 화면 44px 높이 클래스와 focus-visible 바깥선이 있다 — 주소는 13F 포트폴리오 그대로", async () => {
    render(
      <SessionUserProvider user={MEMBER}>
        <InstitutionDetailScreen cik={CIK} />
      </SessionUserProvider>,
    );
    const link = await screen.findByRole("link", { name: "13F 포트폴리오에서 자세히" });
    expect(link.getAttribute("href")).toBe("/institutions");

    // 결함을 직접 보는 단언 먼저(수정 전에는 여기서 실패).
    expect(belowLgTarget(link.getAttribute("class") ?? "")).toBeNull();
    expect(classes(link)).toContain("focus-visible:outline-2");
  });
});
