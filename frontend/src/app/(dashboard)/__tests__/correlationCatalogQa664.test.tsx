/**
 * QA-664 — 상관(/correlation) 화면의 계열 목록(GET /api/analytics/series)이 실패하면 지표 X·Y 고르기가 선택지 없는 빈 상자로 남고, 까닭도 목록을
 * 다시 읽을 방법도 없던 것(개편 전부터 — catalog.error를 쓰지 않음).
 *
 * QA 스택(08e3d838)에서 목록만 503이면 390·1024·1440 모두 '지표 X'·'지표 Y'의 선택지 0개·글 없음, 화면 안에 오류 글·다시 시도 없음. 목록과 상관이
 * 둘 다 503이면 가운데의 상관 오류 상자만 있어, 그 다시 시도로 상관은 돌아와도 고르기는 빈 채였습니다(새로고침·다른 화면에 다녀오기만 남음).
 * 고친 뒤: '비교할 지표' 패널의 고르기 아래에 목록 오류 상자(다시 시도 = 목록만 다시 읽음). 고르기는 막지 않고, 상관 쪽 다시 시도와 묶지 않습니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// 차트는 이 시험의 몫이 아닙니다(jsdom은 크기가 없어 그림을 그리지 않음).
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineSeries: () => <div data-chart="line" />,
  ScatterPlot: () => <div data-chart="scatter" />,
}));

import { endpoints } from "@/lib/endpoints";
import type { CorrelationResponse, SeriesRef } from "@/lib/types";
import CorrelationPage from "../correlation/page";

const SERIES = endpoints.insight.series;
const CORRELATION = endpoints.insight.correlation({ x: "liquidity:net", y: "etf:QQQ", window: "60", years: "3", mode: "change" });

/** 계열 목록 — QA 스택 백엔드의 정적 목록과 같은 스무 개(이름·묶음·단위). */
const CATALOG: { series: SeriesRef[] } = {
  series: [
    ["fred:DGS10", "미국채 10년물", "금리", "%"],
    ["fred:DGS2", "미국채 2년물", "금리", "%"],
    ["fred:T10Y3M", "장단기 금리차 10Y-3M", "금리", "%p"],
    ["fred:DFII10", "10년 실질금리 (TIPS)", "금리", "%"],
    ["fred:T10YIE", "10년 기대인플레 (BEI)", "금리", "%"],
    ["fred:BAMLH0A0HYM2", "하이일드 스프레드", "신용", "%p"],
    ["fred:BAMLC0A0CM", "투자등급(IG) 스프레드", "신용", "%p"],
    ["fred:NFCI", "금융상황지수 (NFCI)", "금융상황", ""],
    ["fred:STLFSI4", "금융스트레스 (STLFSI4)", "금융상황", "pt"],
    ["liquidity:net", "연준 순유동성", "유동성", "조 달러"],
    ["ticker:VIX", "CBOE VIX", "변동성", "pt"],
    ["etf:SPY", "S&P 500 (SPY)", "주식", "$"],
    ["etf:QQQ", "나스닥 100 (QQQ)", "주식", "$"],
    ["etf:IWM", "러셀 2000 (IWM)", "주식", "$"],
    ["etf:TLT", "미국 장기국채 (TLT)", "채권", "$"],
    ["etf:GLD", "금 (GLD)", "원자재", "$"],
    ["etf:USO", "WTI 원유 (USO)", "원자재", "$"],
    ["etf:UUP", "달러 인덱스 (UUP)", "통화", "$"],
    ["etf:EEM", "신흥국 주식 (EEM)", "주식", "$"],
    ["krx:futures", "KOSPI200 선물 종가", "국내", "pt"],
  ].map(([id, label, group, unit]) => ({ id, label, group, unit, source: "QA 시험" })),
};

const CORRELATION_BODY: CorrelationResponse = {
  available: true,
  x: { id: "liquidity:net", label: "연준 순유동성", group: "유동성", unit: "조 달러", source: "FRED 조합 (WALCL−TGA−RRP)" },
  y: { id: "etf:QQQ", label: "나스닥 100 (QQQ)", group: "주식", unit: "$", source: "Yahoo Finance ETF 종가" },
  mode: "change",
  window: 60,
  overall: -0.007,
  samples: 496,
  firstDate: "2024-11-05",
  lastDate: "2026-11-03",
  rolling: [{ date: "2026-11-03", value: -0.01 }],
  scatter: [{ date: "2026-11-03", x: 0.01, y: -0.3 }],
  notes: [],
};

/** 경로별 응답 — 함수면 부를 때마다 그 결과(성공 값 또는 실패). 없는 경로는 끝나지 않는 요청. */
let answers: Record<string, () => Promise<unknown>> = {};
const ok = (body: unknown) => () => Promise.resolve(body);
const fail = () => Promise.reject(new Error("요청 실패 (HTTP 503)"));

beforeEach(() => {
  answers = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in answers ? answers[path]() : new Promise(() => {})));
});
afterEach(() => cleanup());

const seriesCalls = () => api.apiGetShared.mock.calls.filter(([path]) => path === SERIES).length;
const leftPanel = () => screen.getByRole("heading", { name: "비교할 지표" }).closest("section") as HTMLElement;
const xSelect = () => screen.getByRole("combobox", { name: "지표 X" }) as HTMLSelectElement;

describe("QA-664 계열 목록을 읽지 못하면 까닭과 목록 다시 시도를 고르기 아래에 둔다", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 '지표 목록을 읽지 못했습니다' 글이 없었습니다(목록 오류를 화면이 쓰지 않음 — 고르기는 선택지 0개).
  it("목록만 실패하면 '비교할 지표' 패널에 오류 글과 그 상자의 다시 시도, 고르기는 막지 않고 상관은 그대로 그린다", async () => {
    answers[SERIES] = fail;
    answers[CORRELATION] = ok(CORRELATION_BODY);
    render(<CorrelationPage />);

    const message = await within(leftPanel()).findByText("지표 목록을 읽지 못했습니다 — 요청 실패 (HTTP 503)");
    const box = message.closest("div.rounded-control") as HTMLElement;
    expect(within(box).getByRole("button", { name: "다시 시도" })).toBeTruthy();
    // 고르기는 그대로(선택지가 없어도 막지 않음), 상관은 기본 쌍으로 그려집니다 — 다시 시도는 왼쪽 상자 하나뿐.
    expect(xSelect().disabled).toBe(false);
    expect(await screen.findByRole("region", { name: "상관 요약" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(1);
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 목록을 다시 읽을 단추가 없었습니다.
  it("목록 다시 시도는 목록만 한 번 더 읽고, 성공하면 지표 X가 스무 선택지·'연준 순유동성'으로 돌아오며 오류 상자가 걷힌다", async () => {
    answers[SERIES] = fail;
    answers[CORRELATION] = ok(CORRELATION_BODY);
    render(<CorrelationPage />);
    const retry = await within(leftPanel()).findByRole("button", { name: "다시 시도" });
    expect(xSelect().options).toHaveLength(0);
    const correlationCalls = api.apiGetShared.mock.calls.filter(([path]) => path === CORRELATION).length;

    answers[SERIES] = ok(CATALOG);
    expect(seriesCalls()).toBe(1);
    fireEvent.click(retry);
    await waitFor(() => expect(xSelect().options).toHaveLength(20));

    expect(seriesCalls()).toBe(2);
    // 상관은 다시 읽지 않습니다(목록 다시 시도는 목록만).
    expect(api.apiGetShared.mock.calls.filter(([path]) => path === CORRELATION)).toHaveLength(correlationCalls);
    expect(xSelect().value).toBe("liquidity:net");
    expect(xSelect().options[xSelect().selectedIndex].text).toBe("연준 순유동성");
    expect(within(leftPanel()).queryByText(/지표 목록을 읽지 못했습니다/)).toBeNull();
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 둘 다 실패하면 가운데 상관 오류 상자 하나뿐이라, 그 다시 시도로 상관이 돌아와도 고르기는 빈 채였습니다.
  it("목록과 상관이 둘 다 실패하면 오류 상자가 둘(각자 다시 시도) — 왼쪽 다시 시도로 고르기가 되살아난다", async () => {
    answers[SERIES] = fail;
    answers[CORRELATION] = fail;
    render(<CorrelationPage />);
    const left = await within(leftPanel()).findByRole("button", { name: "다시 시도" });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(2));

    answers[SERIES] = ok(CATALOG);
    answers[CORRELATION] = ok(CORRELATION_BODY);
    fireEvent.click(left);
    await waitFor(() => expect(xSelect().options).toHaveLength(20));
    expect(xSelect().options[xSelect().selectedIndex].text).toBe("연준 순유동성");
    expect(within(leftPanel()).queryByRole("button", { name: "다시 시도" })).toBeNull();
    // 상관 쪽 오류 상자는 자기 다시 시도로 — 왼쪽 단추가 상관까지 다시 읽지는 않습니다.
    expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(1);
  });
});

// QA-664 검토: 목록 다시 시도를 누르면 다시 읽는 동안 오류 상자가 통째로 사라졌다가(useApi가 다시 읽기를 시작할 때 error를 비움) 다시 실패하면 되살아났습니다 —
// lg 미만에서는 '비교할 지표' 패널이 결과 위에 있어 아래 전체가 상자 높이만큼 올라갔다가 내려왔습니다(자기 빌드 390 상자 118px·'상관 요약' 띠 y 859 → 729 → 859,
// 768 98px·660 → 550 → 660). 실패 뒤 다시 읽는 동안은 상자 자리에 한 줄이어야 합니다(QA-655가 다른 오류 상자에 정한 꼴).
describe("QA-664 검토 — 목록을 실패 뒤 다시 읽는 동안 상자 자리에 한 줄", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 다시 읽는 동안 '비교할 지표' 패널에 오류 상자도 한 줄도 없었습니다(글을 찾지 못함).
  it.fails("다시 시도 → 응답 전에는 '지표 목록을 다시 읽는 중…' 한 줄(오류 상자 없음), 다시 실패하면 오류 상자로 돌아오고 한 줄은 걷힌다", async () => {
    answers[SERIES] = fail;
    answers[CORRELATION] = ok(CORRELATION_BODY);
    render(<CorrelationPage />);
    const retry = await within(leftPanel()).findByRole("button", { name: "다시 시도" });
    // 첫 실패 뒤에는 상자뿐입니다(한 줄 없음).
    expect(within(leftPanel()).queryByText("지표 목록을 다시 읽는 중…")).toBeNull();

    let failAgain: () => void = () => {};
    answers[SERIES] = () => new Promise((_, reject) => { failAgain = () => reject(new Error("요청 실패 (HTTP 503)")); });
    fireEvent.click(retry);

    expect(seriesCalls()).toBe(2);
    expect(within(leftPanel()).getByText("지표 목록을 다시 읽는 중…")).toBeTruthy();
    expect(within(leftPanel()).queryByText(/지표 목록을 읽지 못했습니다/)).toBeNull();

    await act(async () => failAgain());
    expect(await within(leftPanel()).findByText("지표 목록을 읽지 못했습니다 — 요청 실패 (HTTP 503)")).toBeTruthy();
    expect(within(leftPanel()).queryByText("지표 목록을 다시 읽는 중…")).toBeNull();
  });

  it("처음 읽는 동안(앞선 실패 없음)에는 한 줄을 두지 않는다", () => {
    render(<CorrelationPage />);
    expect(within(leftPanel()).queryByText("지표 목록을 다시 읽는 중…")).toBeNull();
    expect(within(leftPanel()).queryByText(/지표 목록을 읽지 못했습니다/)).toBeNull();
  });
});
