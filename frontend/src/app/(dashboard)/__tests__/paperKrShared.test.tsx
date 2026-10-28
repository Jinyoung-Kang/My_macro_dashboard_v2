/**
 * 🧪 모의매매(한국) 프레임·설정 탭(/paper/kr/framework·/paper/kr/settings) — 두 시장 공용 화면을 한국 화면에서도(사용자 결정 2026-10-29).
 *
 *  - 프레임: 불러오는 중·오류·자료 모두 맨 위에 '두 시장 공용 프레임' 안내, 방법론 메모 고르기는 한국 메모 목록(?market=KR), 저장은 본문
 *    market:"KR", 제안은 같은 공용 경로
 *  - 설정: 불러오는 중·오류·자료 모두 맨 위에 '한 행을 함께 씀' 안내, 보기 기본 '한국 + 공용'(미국 키 숨김) → '전체'로 바꾸면 미국 키,
 *    미국 키에만 '미국 책'(kr.*·공용은 표시 없음), 숨긴 키에 고친 값도 바꿀 값에 남음, 빈 설정 행(초기화 전)은 기본값으로 읽는다는 안내
 *  - 미국 화면은 안내·보기 고르기가 없음
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const KR_OVERVIEW = {
  available: true, market: "KR", currency: "KRW", dormantReason: null, initialized: true, pendingBackfill: [],
  startDate: "2026-10-29", books: [], navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
  claudeExposureSeries: [], frameworkBoundaries: [], limits: [], jobs: [],
};
const US_OVERVIEW = { ...KR_OVERVIEW, market: undefined, currency: undefined, startDate: "2026-10-23" };

const V1 = {
  version: 1, status: "USER", title: "투자 OS 2026-10", rendered: "# 투자 OS — v1", tokensEst: 4200, overBudget: false,
  changelog: "OS 원문 옮김", createdAtKst: "2026-10-25 12:00",
  body: { schemaVersion: 1, title: "투자 OS 2026-10", status: "USER", principles: [{ id: "P1", text: "패킷의 숫자에서 출발한다." }], engines: [], guidance: "" },
};
const FRAMEWORK = {
  available: true, current: V1,
  versions: [{ version: 1, title: V1.title, changelog: V1.changelog, createdAtKst: V1.createdAtKst, sourceProposalId: null }],
};

const KEYS = [
  { key: "model", type: "string", min: null, max: null, affectsRules: false, market: null, description: "두 책 공용 모델", options: null },
  { key: "apiDailyCallCap", type: "integer", min: 1, max: 100, affectsRules: false, market: null, description: null },
  { key: "rulesMaxNames", type: "integer", min: 1, max: 30, affectsRules: true, market: "US", description: "미국 규칙 계좌 종목 수" },
  { key: "kr.rulesMaxNames", type: "integer", min: 1, max: 30, affectsRules: true, market: "KR", description: "한국 규칙 계좌 종목 수" },
  { key: "kr.slippageBp", type: "number", min: 0, max: 50, affectsRules: true, market: "KR", description: null },
];
const SETTINGS = {
  available: true, version: 4,
  body: { model: "claude-sonnet-5-5", apiDailyCallCap: 20, rulesMaxNames: 15, kr: { rulesMaxNames: 12, slippageBp: 5 } },
  defaults: { model: "claude-sonnet-5-5", apiDailyCallCap: 20, rulesMaxNames: 15, kr: { rulesMaxNames: 12, slippageBp: 5 } },
  keys: KEYS,
};

let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {
    "/api/paper/overview?market=KR": () => Promise.resolve(KR_OVERVIEW),
    "/api/paper/overview": () => Promise.resolve(US_OVERVIEW),
    "/api/paper/settings/history": () => Promise.resolve({ available: true, history: [] }),
    "/api/paper/framework/proposals": () => Promise.resolve({ available: true, proposals: [] }),
  };
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (reads[path] ? reads[path]() : new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FRAMEWORK_NOTE = /^두 시장 공용 프레임 — 미국·한국 Claude 계좌가 같은 판을 씁니다/;
const SETTINGS_NOTE = /^설정은 두 시장이 한 행\(한 버전\)을 함께 씁니다/;

describe("한국 프레임 탭(두 시장 공용)", () => {
  it("불러오는 중: 공용 안내가 먼저 보이고 읽는 중 표시", async () => {
    reads["/api/paper/framework"] = () => new Promise(() => {});
    render(<PaperPage market="KR" initialTab="framework" />);
    expect(await screen.findByText(FRAMEWORK_NOTE)).toBeTruthy();
    expect(screen.getByText("프레임을 읽는 중…")).toBeTruthy();
  });

  it("오류: 공용 안내와 오류 + 다시 시도", async () => {
    reads["/api/paper/framework"] = () => Promise.reject(new Error("프레임 응답 500"));
    render(<PaperPage market="KR" initialTab="framework" />);
    expect(await screen.findByText("프레임 응답 500")).toBeTruthy();
    expect(screen.getByText(FRAMEWORK_NOTE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });

  it("자료: 같은 판, 방법론 메모 고르기는 한국 메모(?market=KR)·저장은 market:\"KR\", 제안은 공용 경로", async () => {
    reads["/api/paper/framework"] = () => Promise.resolve(FRAMEWORK);
    reads["/api/paper/notes?includeExpired=false&market=KR"] = () => Promise.resolve({
      available: true, market: "KR", referenceDate: "2026-10-28",
      notes: [{ id: 31, kind: "INSIGHT", asOfDate: "2026-10-28", expiresOn: null, title: "한국 수급 방법론", body: "외국인 20일", archived: false, active: true, createdAtKst: null }],
    });
    api.apiPost.mockImplementation((path: string) => (path === "/api/paper/notes"
      ? Promise.resolve({ ok: true, market: "KR", note: { id: 32, kind: "INSIGHT", title: "투자 OS 갱신", body: "원문", archived: false, active: true } })
      : new Promise(() => {})));
    render(<PaperPage market="KR" initialTab="framework" />);
    expect((await screen.findAllByText("투자 OS 2026-10")).length).toBeGreaterThan(0);
    expect(screen.getByText(FRAMEWORK_NOTE)).toBeTruthy();
    const picker = await screen.findByLabelText("이미 있는 방법론 메모로 요청");
    expect(within(picker).getByRole("option", { name: /#31 한국 수급 방법론/ })).toBeTruthy();
    const paths = api.apiGetShared.mock.calls.map(([path]) => path);
    expect(paths).not.toContain("/api/paper/notes?includeExpired=false");

    fireEvent.change(screen.getByLabelText("방법론 글"), { target: { value: "원문" } });
    fireEvent.click(screen.getByRole("button", { name: "① 메모로 저장" }));
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/notes", expect.objectContaining({ kind: "INSIGHT", body: "원문", market: "KR" }));
  });

  it("미국 화면에는 공용 안내가 없고 메모 고르기는 미국 목록", async () => {
    reads["/api/paper/framework"] = () => Promise.resolve(FRAMEWORK);
    reads["/api/paper/notes?includeExpired=false"] = () => Promise.resolve({ available: true, referenceDate: "2026-10-27", notes: [] });
    render(<PaperPage initialTab="framework" />);
    expect((await screen.findAllByText("투자 OS 2026-10")).length).toBeGreaterThan(0);
    expect(screen.queryByText(FRAMEWORK_NOTE)).toBeNull();
    await waitFor(() => expect(api.apiGetShared.mock.calls.map(([path]) => path)).toContain("/api/paper/notes?includeExpired=false"));
  });
});

describe("한국 설정 탭(두 시장 공용)", () => {
  it("불러오는 중: 공용 안내가 먼저 보이고 읽는 중 표시", async () => {
    reads["/api/paper/settings"] = () => new Promise(() => {});
    render(<PaperPage market="KR" initialTab="settings" />);
    expect(await screen.findByText(SETTINGS_NOTE)).toBeTruthy();
    expect(screen.getByText("설정을 읽는 중…")).toBeTruthy();
  });

  it("오류: 공용 안내와 오류 + 다시 시도", async () => {
    reads["/api/paper/settings"] = () => Promise.reject(new Error("설정 응답 500"));
    render(<PaperPage market="KR" initialTab="settings" />);
    expect(await screen.findByText("설정 응답 500")).toBeTruthy();
    expect(screen.getByText(SETTINGS_NOTE)).toBeTruthy();
  });

  it("자료: 보기 기본 '한국 + 공용'(미국 키 숨김) → '전체'면 미국 키('미국 책' 표시), 숨긴 키의 고친 값도 남음", async () => {
    reads["/api/paper/settings"] = () => Promise.resolve(SETTINGS);
    render(<PaperPage market="KR" initialTab="settings" />);
    expect(await screen.findByLabelText("kr.rulesMaxNames")).toBeTruthy();
    expect(screen.getByLabelText("model")).toBeTruthy();
    expect(screen.queryByLabelText("rulesMaxNames")).toBeNull();
    const view = screen.getByLabelText("보기") as HTMLSelectElement;
    expect(view.value).toBe("market");
    expect(within(view).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "한국 + 공용 (4개)", "전체 — 미국 키 포함 (5개)",
    ]);
    // 표시는 미국 키의 '미국 책'뿐 — kr.* 키는 이름이 말하고 공용 키는 표시 없음(안내 글과 같은 규칙).
    expect(screen.queryByText("한국 책")).toBeNull();
    expect(screen.queryByText("미국 책")).toBeNull();

    fireEvent.change(view, { target: { value: "all" } });
    const us = await screen.findByLabelText("rulesMaxNames");
    expect(screen.getByText("미국 책")).toBeTruthy();
    fireEvent.change(us, { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("보기"), { target: { value: "market" } });
    expect(screen.queryByLabelText("rulesMaxNames")).toBeNull();
    // 숨긴 미국 키의 고친 값도 바꿀 값에 남습니다(보기를 바꿔도 빠지지 않음).
    const pending = screen.getByRole("region", { name: "바꿀 값" });
    expect(within(pending).getByText("바꿀 값 (1)")).toBeTruthy();
    expect(within(pending).getByText("rulesMaxNames")).toBeTruthy();
  });

  it("빈 설정 행(초기화 전): 기본값으로 읽는다는 안내와 함께 키를 보인다", async () => {
    reads["/api/paper/settings"] = () => Promise.resolve({ ...SETTINGS, version: null, body: {} });
    render(<PaperPage market="KR" initialTab="settings" />);
    expect(await screen.findByText(/설정 행이 아직 없습니다\(초기화 전\) — 아래 값은 기본값입니다/)).toBeTruthy();
    expect(screen.getByLabelText("kr.slippageBp")).toBeTruthy();
    expect(screen.getAllByText(/설정 행에 없음 — 기본값으로 읽음/).length).toBeGreaterThan(0);
  });

  it("미국 화면은 안내·보기 고르기 없이 모든 키(예전 그대로)", async () => {
    reads["/api/paper/settings"] = () => Promise.resolve(SETTINGS);
    render(<PaperPage initialTab="settings" />);
    expect(await screen.findByLabelText("rulesMaxNames")).toBeTruthy();
    expect(screen.getByLabelText("kr.rulesMaxNames")).toBeTruthy();
    expect(screen.queryByText(SETTINGS_NOTE)).toBeNull();
    expect(screen.queryByLabelText("보기")).toBeNull();
    expect(screen.queryByText("한국 책")).toBeNull();
  });
});
