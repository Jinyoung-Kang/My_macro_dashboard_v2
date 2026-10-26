/**
 * 선택·열림 상태를 색만이 아니라 보조 기술에도 알린다(QA-052) — 화면 낭독기는 색을 읽지 못합니다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError, auth: { logout: vi.fn() } };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({
  token: 0, reloadAll: () => {}, notifyUnauthorized: () => {}, requestRefresh: () => {}, collecting: false, message: null,
}));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => ({ usePathname: () => "/macro", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { SearchCommand } from "@/components/shell/SearchCommand";
import ConsensusPage from "../consensus/page";
import { FxCompareSection } from "../macro/FxCompareSection";

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/macro/fx")) {
      return Promise.resolve({ available: true, series: [], catalog: [
        { id: "usdkrw", label: "원/달러" }, { id: "dxy", label: "달러 인덱스" }, { id: "usdjpy", label: "엔/달러" }] });
    }
    if (path.startsWith("/api/sec13f/institutions")) {
      return Promise.resolve({ institutions: [{ name: "Berkshire", cik: "1" }, { name: "Bridgewater", cik: "2" }] });
    }
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

describe("QA-052 상태를 aria로 알린다", () => {
  // 수정 전에는 선택 여부가 색으로만 전달됐다(RangeTabs만 aria-pressed가 있었음).
  it("환율 비교 계열 버튼은 aria-pressed로 켜짐을 알린다", async () => {
    render(<FxCompareSection />);
    expect((await screen.findByRole("button", { name: "원/달러" })).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "엔/달러" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("13F 교집합의 기관 버튼은 aria-pressed로 포함 여부를 알린다", async () => {
    render(<ConsensusPage />);
    expect((await screen.findByRole("button", { name: "Berkshire" })).getAttribute("aria-pressed")).toBe("true");
  });

  // 옛 사이드바의 "메뉴 열기/닫기" 단추는 셸(하단 탭 바)로 없어졌고, 여닫는 단추는 이제 통합 검색 단추입니다.
  it("통합 검색 단추는 aria-haspopup=dialog·aria-expanded로 열림을 알린다", () => {
    render(<SearchCommand user={{ email: "m@test.local", role: "MEMBER", tier: "PRO", demo: false }} />);
    const trigger = screen.getByRole("button", { name: "종목·기관·지표·메뉴 검색" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "통합 검색" })).toBeTruthy();
  });
});
