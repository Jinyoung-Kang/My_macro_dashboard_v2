/**
 * 수급 레이더 — 실패 뒤 다시 읽는 동안의 자리 — QA-895(D6 전 QA 반박 확인에서 찾음 — QA-892 고침 `970e87b3`이 만든 새 동작).
 *
 * QA-892는 첫 적재 자리(머리 동작의 신선도 배지 폭 자리, 시장 전체 패널의 기준일 줄·본문 36/32/28rem 자리, 순위 읽는 중 `min-h-dvh`)를 `loading && !data`로
 * 켰습니다. 그런데 읽기가 실패한 뒤 다시 읽는 동안(60초·300초 자동 갱신, 탭 복귀, '다시 시도')도 hooks/useApi가 error를 비우고 failedAt만 남겨 같은 식이
 * 참이라, 다시 읽을 때마다 큰 자리표시가 오류 상자와 번갈아 켜졌습니다 — 순위 503이면 1024에서 머리 동작 묶음이 둘째 줄로 꺾였다 돌아와(머리 73 ↔ 111px)
 * 주기마다 CLS +0.54, 390 +0.20, 시장 전체 투자자별 매매대금 503이면 패널이 오류 상자 148 ↔ 569px로 바뀌어 1024~1440 +0.25~0.26(QA 스택 0~0.009).
 *
 * 기대: 큰 자리표시·보이지 않는 자리는 처음 읽는 동안(`firstLoadPending` — 값도 앞선 실패도 없음, QA-655)만. 실패 뒤 다시 읽는 동안은 오류 상자와 비슷한
 * 높이의 '불러오는 중' 한 줄(QA 스택과 같은 꼴).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected <span aria-hidden="true" …(1)>…(1)</span> to be null'(다시 읽는 동안 머리 동작에 신선도 자리).
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  HorizontalBars: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
  SignedBars: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
}));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";
import RadarPage from "../radar/page";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO" };
const OPTIONS = {
  markets: ["KOSPI", "KOSDAQ"],
  investors: ["외국인", "기관"],
  supportedInvestors: ["외국인", "기관"],
  tradeTypes: ["순매수", "순매도"],
  intervals: ["TODAY"],
};

/** 순위·시장 전체 매매대금은 실패, 선택지는 답함, 나머지는 기다리는 중. `failing`이 거짓이면 실패하던 둘도 기다리는 중(다시 읽는 동안). */
let failing = true;
beforeEach(() => {
  failing = true;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/radar/options")) return Promise.resolve(OPTIONS);
    if (path.startsWith("/api/radar/ranking") || path.startsWith("/api/kr/investor-flows")) {
      return failing ? Promise.reject(new Error("합성 실패")) : new Promise(() => {});
    }
    return new Promise(() => {});
  });
});
afterEach(() => cleanup());

async function settle() {
  for (let round = 0; round < 6; round += 1) await act(async () => {});
}

const tokens = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("수급 레이더 실패 뒤 다시 읽는 동안(QA-895)", () => {
  it.fails("탭 복귀로 다시 읽는 동안: 머리 동작의 신선도 자리·시장 전체 패널의 기준일 줄·본문 자리·순위 화면 높이 자리를 다시 켜지 않는다", async () => {
    render(<SessionUserProvider user={OWNER}><RadarPage /></SessionUserProvider>);
    await settle();
    // 실패한 뒤 — 순위는 오류 상자, 시장 전체 패널은 주의 상자.
    expect(screen.getByText("다시 시도")).toBeTruthy();
    const market = () => screen.getByRole("heading", { name: "코스피 전체 투자자별 매매대금" }).closest("section") as HTMLElement;
    expect(within(market()).getByText("합성 실패")).toBeTruthy();

    // 탭 복귀 — useApi가 실패한 두 읽기를 다시 부르고, 이번 응답은 아직 오지 않음.
    failing = false;
    const before = api.apiGetShared.mock.calls.length;
    expect(document.visibilityState).toBe("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    const again = api.apiGetShared.mock.calls.slice(before).map(([path]) => String(path));
    expect(again.some((path) => path.startsWith("/api/radar/ranking"))).toBe(true);
    expect(again.some((path) => path.startsWith("/api/kr/investor-flows"))).toBe(true);

    // 머리 동작 — 신선도 자리(보이지 않는 '수집' + 시각)가 다시 켜지지 않음.
    const actions = screen.getByRole("button", { name: "새로고침" }).parentElement as HTMLElement;
    expect(within(actions).queryByText("수집")?.closest("[aria-hidden='true']") ?? null).toBeNull();
    // 시장 전체 패널 — 기준일 줄 자리·본문 자리 없이 읽는 중 한 줄.
    expect(market().querySelector("header p > [aria-hidden='true']")).toBeNull();
    expect(market().querySelector("[class*='min-h-[36rem]']")).toBeNull();
    expect(within(market()).getByText("불러오는 중…")).toBeTruthy();
    // 순위 — 화면 높이 자리 없이 읽는 중 한 줄.
    const ranking = screen.getByText("수급 데이터를 불러오는 중…");
    expect(tokens(ranking.parentElement)).not.toContain("min-h-dvh");
  });
});
