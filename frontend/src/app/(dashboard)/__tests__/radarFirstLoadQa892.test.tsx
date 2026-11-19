/**
 * 수급 레이더 첫 적재 자리 — QA-892(D6 전 QA 스택 확인에서 찾음 — 1024~1279 몫은 작업대 P7 회귀, 나머지는 개편 전부터: 2026-10-02 QA O-10).
 *
 * /radar 첫 적재 CLS가 1024 0.5989·1440 0.5903·1920 0.4645(기준 0.5091·0.5823·0.4582) — 응답이 한 프레임에 오며 (1) 시장 전체 패널이 읽는 중 한 줄
 * (본문 92~100px)에서 표 + 막대 240px(본문 448~577px)로 자라 아래 패널 셋을 화면 밖으로 밀고, (2) 순위가 읽는 중 한 줄에서 막대 + 표(약 1,900px)로 자라
 * 공통·이력 패널을 밀고, (3) 머리 동작 묶음이 신선도('수집' + 시각)가 붙으며 260 → 406px가 되어 P7에서 좁아진 제목 칸(548 → 419px) 옆에 자리가 없어
 * 둘째 줄로 꺾였습니다(1024·1100 — 머리 73 → 111px, P7 회귀 몫).
 *
 * 기대(값이 온 뒤의 꼴로 자리 — QA-876·882와 같은 원칙): 응답 전에도 머리 동작에 신선도 배지와 같은 폭의 보이지 않는 자리(낭독 없음), 시장 전체 패널
 * 머리에 기준일 줄 높이의 글 없는 자리(날짜를 만들지 않음), 본문에 표 + 막대 높이 자리(좁은 화면 36rem · md 32rem · lg 28rem), 순위 읽는 중 자리는 화면 높이 이상(아래 패널을 첫 화면 밖에).
 * 응답 뒤의 겉모습·요청은 그대로입니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'expected null to be truthy'(머리 동작에 신선도 자리 없음).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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

beforeEach(() => {
  api.apiGetShared.mockReset();
  // 모든 응답이 아직 오지 않은 첫 프레임.
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => cleanup());

const tokens = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("수급 레이더 첫 적재 자리(QA-892)", () => {
  it("응답 전: 머리 동작의 신선도 자리, 시장 전체 패널의 기준일 줄·본문 자리, 순위 읽는 중 자리(화면 높이 이상)", () => {
    render(<SessionUserProvider user={OWNER}><RadarPage /></SessionUserProvider>);
    // 머리 동작 — '새로고침' 단추와 같은 묶음에 '수집' + 시각 꼴의 보이지 않는 자리(낭독 없음).
    const actions = screen.getByRole("button", { name: "새로고침" }).parentElement as HTMLElement;
    const slot = within(actions).queryByText("수집")?.closest("[aria-hidden='true']") ?? null;
    expect(slot).toBeTruthy();
    expect(tokens(slot)).toContain("invisible");
    expect(slot?.textContent).toMatch(/^수집\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    // 시장 전체 패널 — 기준일 줄 자리(보이지 않음)와 본문 자리.
    const market = screen.getByRole("heading", { name: "코스피 전체 투자자별 매매대금" }).closest("section") as HTMLElement;
    const subtitle = market.querySelector("header p > [aria-hidden='true']");
    expect(tokens(subtitle)).toContain("invisible");
    expect(subtitle?.textContent?.trim()).toBe("");
    const loading = within(market).getByText("불러오는 중…").parentElement;
    expect(tokens(loading)).toEqual(expect.arrayContaining(["min-h-[36rem]", "md:min-h-[32rem]", "lg:min-h-[28rem]"]));

    // 순위 읽는 중 — 화면 높이 이상의 자리.
    const ranking = screen.getByText("수급 데이터를 불러오는 중…").parentElement;
    expect(tokens(ranking)).toContain("min-h-dvh");
  });
});
