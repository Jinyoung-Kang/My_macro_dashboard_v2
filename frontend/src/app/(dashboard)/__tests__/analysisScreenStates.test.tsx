/**
 * 공통 보유(/consensus)·스타일(/style)·스코어카드(/scorecard) 화면 시험 — 공유 시험 파일에서 앞의 두 화면 사례만 옮겨 왔습니다(P5b 패턴 단계, 내용 그대로).
 *
 * 원래 파일·describe 이름 그대로 옮김:
 *  - tinyWeightQa454.test.tsx: "13F 비중이 0보다 크고 0.005% 미만이면 '<0.01%'(QA-454)"의 '공통 보유 — 교집합·공통 신규 매수의 평균·최대 비중'·
 *    '스타일 화면 — 이 종목을 누가 들고 있나'
 * 모의·합성 응답·도우미 함수는 원래 파일의 것을 글자 그대로 복사했습니다(이 사례들이 쓰는 것만). P5b 두 화면 갈래(13F 포트폴리오 · 교집합·스타일·스코어카드)가
 * 화면을 바꿀 때 서로의 시험 파일을 고치지 않게 갈래마다 파일을 나눈 것입니다(나머지 사례는 원래 파일에 남음).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트를 재지 못해 그림은 빼고 이름만 둡니다(비중 글은 표·목록에 있음). 표 히트맵(HeatmapTable — 그림이 아니라 표, Recharts 없음)은
// 패턴 배럴의 부품이라 이 모의에 걸리지 않고 실제로 그려집니다(스타일 화면 유사도 행렬의 칸·단계를 봄 — QA-707).
vi.mock("@/components/charts", () => ({
  LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
  MultiLineSeries: () => null,
  WeightHeatmap: () => null,
  HorizontalBars: () => null,
}));

import { kstToday, rangeStart } from "@/lib/infoSearch";
import type { GuruHoldersResponse } from "@/lib/types";
import ConsensusPage from "../consensus/page";
import ScorecardPage from "../scorecard/page";
import GuruPage from "../style/page";

const TINY = "<0.01%";
const ZERO = "0.00%";

const QUERY = "SYNTHETIC TINY HOLDINGS";

let reportDate = "";
let reads: Record<string, unknown> = {};

/** 보유 줄 둘 — 큰 기관이 아주 작게 든 줄(0.0032%)과 보통 줄(1.25%). */
function holders(): GuruHoldersResponse {
  return {
    available: true, query: QUERY, totalMatches: 2, truncated: false,
    rows: [
      { institution: "합성 자산운용", cik: "0000000011", name: "SYNTHETIC TINY HOLDINGS", cusip: "000000201", weight: 1.25, value: 50_000_000, reportDate },
      { institution: "가상 연기금", cik: "0000000012", name: "SYNTHETIC TINY HOLDINGS", cusip: "000000201", weight: 0.0032, value: 320_000_000, reportDate },
    ],
  };
}

beforeEach(() => {
  reportDate = rangeStart("30d", kstToday(Date.now()));
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

/** root 안에 아주 작은 비중이 '<0.01%'로 보이고 '0.00%'는 없는지. */
function expectTiny(root: HTMLElement) {
  expect(within(root).queryByText(ZERO)).toBeNull();
  expect(within(root).getAllByText(TINY).length).toBeGreaterThan(0);
}

describe("13F 비중이 0보다 크고 0.005% 미만이면 '<0.01%'(QA-454)", () => {
  it("공통 보유 — 교집합·공통 신규 매수의 평균·최대 비중", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [reportDate], reportDate: null, minHolders: 2,
          rows: [{ key: "cusip:000000201", name: "SYNTHETIC TINY HOLDINGS", cusip: "000000201", holders: ["가상 연기금"], actions: [], holderCount: 2,
            totalValue: 320_000_000, avgWeight: 0.003, maxWeight: 0.004, buyCount: 0, sellCount: 0 }],
        });
      }
      if (path.startsWith("/api/sec13f/new-buys")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [], minHolders: 3, note: "13F는 분기 공시입니다.",
          rows: [{ key: "cusip:000000202", name: "SYNTHETIC NEW CO", cusip: "000000202", buyers: ["가상 연기금"], buyerCount: 3,
            totalValue: 100, avgWeight: 0.002, reportDate }],
        });
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    const both = (await screen.findByText("SYNTHETIC TINY HOLDINGS")).closest("table") as HTMLElement;
    expect(within(both).getAllByText(TINY)).toHaveLength(2);
    expect(within(both).queryByText(ZERO)).toBeNull();
    const fresh = (await screen.findByText("SYNTHETIC NEW CO")).closest("table") as HTMLElement;
    expectTiny(fresh);
  });

  it("스타일 화면 — 이 종목을 누가 들고 있나", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/holders") ? Promise.resolve(holders()) : new Promise(() => {}));
    render(<GuruPage />);
    fireEvent.change(screen.getByPlaceholderText("NVIDIA"), { target: { value: QUERY } });
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    const card = screen.getByRole("heading", { name: "이 종목을 누가 들고 있나" }).closest("section") as HTMLElement;
    await waitFor(() => expect(within(card).getByText("1.25%")).toBeTruthy());
    expectTiny(card);
  });
});

describe("교집합 — 동시 매수·매도·새로 담은 기관 수는 개수라 등락색이 아니다(QA-703)", () => {
  // 수정 전 실패: 동시 매수 칸 'text-up'(빨강)·동시 매도 칸 'text-down'(파랑)·새로 담은 기관 칸 'text-up' — 개수(기관 몇 곳)가 오르내린 값처럼 칠해짐.
  it("교집합 표·공통 신규 매수 표의 개수 칸에 상승·하락 글자색이 없고, 개수 글은 그대로 보인다", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [reportDate], reportDate: null, minHolders: 2,
          rows: [{ key: "cusip:000000301", name: "SYNTHETIC COUNT CO", cusip: "000000301", holders: ["가상 연기금"], actions: [], holderCount: 3,
            totalValue: 1_000_000, avgWeight: 1.5, maxWeight: 2.5, buyCount: 2, sellCount: 1 }],
        });
      }
      if (path.startsWith("/api/sec13f/new-buys")) {
        return Promise.resolve({
          available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [], minHolders: 3, note: "13F는 분기 공시입니다.",
          rows: [{ key: "cusip:000000302", name: "SYNTHETIC FRESH CO", cusip: "000000302", buyers: ["가상 연기금"], buyerCount: 3,
            totalValue: 100, avgWeight: 0.5, reportDate }],
        });
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    const both = (await screen.findByText("SYNTHETIC COUNT CO")).closest("table") as HTMLElement;
    const fresh = (await screen.findByText("SYNTHETIC FRESH CO")).closest("table") as HTMLElement;
    const tinted = [...both.querySelectorAll(".text-up, .text-down"), ...fresh.querySelectorAll(".text-up, .text-down")].map(
      (element) => `${element.className} '${element.textContent}'`,
    );
    expect(tinted).toEqual([]);
    expect(within(both).getByText("2")).toBeTruthy();
    expect(within(both).getByText("1")).toBeTruthy();
    expect(within(fresh).getByText("3곳")).toBeTruthy();
  });
});

describe("교집합 — 네 상태(읽는 중·오류·저장본 없음·모르는 값)", () => {
  const consensusOnly = (answer: () => Promise<unknown>) =>
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/sec13f/consensus") ? answer() : new Promise(() => {})));

  it("읽는 중이면 교집합 요약 자리에 같은 세 타일의 자리표시, 조건 고르기는 그대로", async () => {
    consensusOnly(() => new Promise(() => {}));
    render(<ConsensusPage />);
    const strip = await screen.findByRole("region", { name: "교집합 요약" });
    expect(within(strip).getAllByRole("status").map((status) => status.getAttribute("aria-label"))).toEqual([
      "참여 기관 불러오는 중",
      "교집합 종목 불러오는 중",
      "교집합 기준 분기 불러오는 중",
    ]);
    expect(screen.getByLabelText("기준 분기")).toBeTruthy();
    expect(screen.getByLabelText("최소 공통 보유 기관 수")).toBeTruthy();
  });

  it("읽지 못하면 오류와 '다시 시도' — 누르면 교집합을 한 번 더 읽는다", async () => {
    consensusOnly(() => Promise.reject(new Error("교집합을 읽지 못했습니다.")));
    render(<ConsensusPage />);
    expect(await screen.findByText("교집합을 읽지 못했습니다.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "교집합 요약" })).toBeNull();
    const before = api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/sec13f/consensus")).length;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() =>
      expect(api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/sec13f/consensus")).length).toBe(before + 1));
  });

  it("조건을 만족하는 종목이 없으면(저장본 없음) 그 안내만 — 요약 띠·표는 없다", async () => {
    consensusOnly(() => Promise.resolve({ available: false, participants: [], participantCount: 0, availableDates: [], reportDate: null, minHolders: 2, rows: [] }));
    render(<ConsensusPage />);
    expect(await screen.findByText(/조건을 만족하는 공통 보유 종목이 없습니다/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "교집합 요약" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("모르는 비중·평가액은 '—'(0으로 채우지 않음), 요약 띠는 값", async () => {
    consensusOnly(() => Promise.resolve({
      available: true, participants: ["가상 연기금"], participantCount: 1, availableDates: [], reportDate: "2026-06-30", minHolders: 2,
      rows: [{ key: "cusip:000000401", name: "SYNTHETIC UNKNOWN CO", cusip: "000000401", holders: ["가상 연기금"], actions: [], holderCount: 2,
        totalValue: null, avgWeight: null, maxWeight: null, buyCount: 0, sellCount: 0 }],
    }));
    render(<ConsensusPage />);
    const table = (await screen.findByText("SYNTHETIC UNKNOWN CO")).closest("table") as HTMLElement;
    expect(within(table).getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(within(table).queryByText("0.00%")).toBeNull();
    const strip = screen.getByRole("region", { name: "교집합 요약" });
    expect(within(strip).getByRole("group", { name: "교집합 기준 분기" }).textContent).toContain("2026-06-30");
    expect(within(strip).getByRole("group", { name: "참여 기관" }).textContent).toContain("1곳");
  });
});

describe("교집합 — 검사 칸(종목 이름 → 대화상자)", () => {
  it("교집합 줄의 이름을 누르면 대화상자에 속성·보유 기관 배지, 닫으면 그 이름 단추로 포커스가 돌아온다", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: ["🇺🇸 가상 자산운용 (Synthetic AM)", "가상 연기금"], participantCount: 2, availableDates: [], reportDate: null, minHolders: 2,
          rows: [{ key: "issuer:000000", name: "SYNTHETIC HOLDER CO", cusip: "000000501", holders: ["🇺🇸 가상 자산운용 (Synthetic AM)", "가상 연기금"],
            actions: [], holderCount: 2, totalValue: 2_000_000_000, avgWeight: 4.5, maxWeight: 6.25, buyCount: 1, sellCount: 1 }],
        });
      }
      if (path.startsWith("/api/macro/usdkrw")) return Promise.resolve({ available: true, rate: 1400, lastTs: "2026-11-04 20:19 KST" });
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    const trigger = await screen.findByRole("button", { name: "SYNTHETIC HOLDER CO" });
    // 표에는 보유 기관 목록 열이 없습니다(검사 칸으로 옮김).
    const table = trigger.closest("table") as HTMLElement;
    expect(within(table).queryByText("보유 기관 목록")).toBeNull();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "SYNTHETIC HOLDER CO" });
    const value = (label: string) => within(dialog).getByText(label).nextElementSibling?.textContent;
    expect(value("증권 구분")).toBe("발행사 000000 · 보통주 합산");
    expect(value("보유 기관 수")).toBe("2곳");
    expect(value("동시 매수")).toContain("1곳");
    expect(value("동시 매도")).toContain("1곳");
    expect(value("최대 비중")).toBe("6.25%");
    expect(value("합산 평가액")).toBe("20.0억 달러");
    expect(value("원화 환산")).toContain("원/달러 1,400.00 기준");
    const holders = within(dialog).getByRole("region", { name: "보유 기관" });
    // 배지 글은 국기를 뗀 전체 이름 — 첫 낱말이 같은 두 기관도 갈리고, 마우스 설명(title)에만 두지 않음(P5b 검토 지적).
    expect(within(holders).getAllByRole("listitem").map((item) => [item.textContent, item.getAttribute("title")])).toEqual([
      ["가상 자산운용 (Synthetic AM)", null],
      ["가상 연기금", null],
    ]);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  // 기관 배지가 공용 SourceBadge(바탕 surface-2만, 테두리 없음)라 같은 surface-2인 대화상자 면 위에서 보통 모드 1.00:1로 상자가 사라지고, 고대비에서도 바탕이
  // Canvas로 지워져 상자가 없었음(P5b QA 스택 확인 — 배지를 표 열에서 검사 대화상자로 옮긴 뒤. 13F 보유 표 QA-697과 같은 무리). jsdom이라 그리지 않고
  // 클래스로 셉니다(QA-697 사례 꼴 — 테두리가 있거나, 없으면 놓인 면과 다른 바탕).
  // 수정 전 실패(plain it): 배지 둘 모두 { bordered: false, same: ["bg-surface-2"] }.
  it("대화상자의 기관 배지는 테두리 있는 상자 — 놓인 대화상자 면과 같은 바탕의 테두리 없는 배지가 없다(QA-725)", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/consensus")) {
        return Promise.resolve({
          available: true, participants: ["🇺🇸 가상 자산운용 (Synthetic AM)", "가상 연기금"], participantCount: 2, availableDates: [], reportDate: null, minHolders: 2,
          rows: [{ key: "issuer:000000", name: "SYNTHETIC HOLDER CO", cusip: "000000501", holders: ["🇺🇸 가상 자산운용 (Synthetic AM)", "가상 연기금"],
            actions: [], holderCount: 2, totalValue: 2_000_000_000, avgWeight: 4.5, maxWeight: 6.25, buyCount: 1, sellCount: 1 }],
        });
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    fireEvent.click(await screen.findByRole("button", { name: "SYNTHETIC HOLDER CO" }));
    const dialog = await screen.findByRole("dialog", { name: "SYNTHETIC HOLDER CO" });
    const holders = within(dialog).getByRole("region", { name: "보유 기관" });
    const bg = (element: Element) => [...element.classList].filter((name) => name.startsWith("bg-"));
    // 배지가 놓인 면 — 배지 목록에서 위로 올라가 처음 만나는 바탕(대화상자 면 bg-surface-2).
    let surface: HTMLElement | null = holders;
    while (surface && bg(surface).length === 0) surface = surface.parentElement;
    expect(surface !== null && dialog.contains(surface) ? bg(surface) : []).toContain("bg-surface-2");
    const boxes = within(holders).getAllByRole("listitem").map((item) => item.firstElementChild as HTMLElement);
    expect(
      boxes.map((box) => {
        const bordered = box.classList.contains("border");
        return { bordered, same: bordered ? [] : bg(box).filter((token) => surface !== null && bg(surface).includes(token)) };
      }),
    ).toEqual([
      { bordered: true, same: [] },
      { bordered: true, same: [] },
    ]);
  });
});

describe("교집합 — 왼쪽 칸 차례(2026-11-18 결정(사용자 위임 — 권장안 가) lg-conditions-below-list)", () => {
  it("왼쪽 칸의 패널 제목 차례는 '조건' → '분석 대상'이다(목록 아래면 넓은 화면에서 조건이 첫 화면 밖)", () => {
    render(<ConsensusPage />);
    const titles = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(titles.indexOf("조건")).toBeGreaterThanOrEqual(0);
    expect(titles.indexOf("조건")).toBeLessThan(titles.indexOf("분석 대상"));
  });
});

describe("교집합 — 분석 대상 거르기 목록(옛 기관 칩)", () => {
  const INSTITUTIONS = {
    institutions: [
      { key: "a", name: "🇺🇸 가상 자산운용 (Synthetic AM)", cik: "1", desc: "" },
      { key: "b", name: "가상 연기금", cik: "2", desc: "" },
      { key: "c", name: "가상 국부펀드", cik: "3", desc: "" },
    ],
  };

  it("처음엔 모두 켬(빈 고름 = 전체 — QA-003), 하나를 끄면 개수 'n곳 / 전체곳'이 줄고 마지막 하나까지 끄면 다시 전체", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/sec13f/institutions") ? Promise.resolve(INSTITUTIONS) : new Promise(() => {}));
    render(<ConsensusPage />);
    const group = await screen.findByRole("group", { name: "분석 대상 기관" });
    const pressed = () => within(group).getAllByRole("button").map((button) => [button.textContent, button.getAttribute("aria-pressed")]);
    await waitFor(() => expect(pressed()).toEqual([["가상 자산운용 (Synthetic AM)", "true"], ["가상 연기금", "true"], ["가상 국부펀드", "true"]]));
    const panel = group.closest("section") as HTMLElement;
    expect(within(panel).getByText("3곳 / 3곳")).toBeTruthy();

    fireEvent.click(within(group).getByRole("button", { name: "가상 연기금" }));
    expect(pressed()).toEqual([["가상 자산운용 (Synthetic AM)", "true"], ["가상 연기금", "false"], ["가상 국부펀드", "true"]]);
    expect(within(panel).getByText("2곳 / 3곳")).toBeTruthy();

    // 낭독기 알림 — 고름이 바뀌면 개수, 마지막 하나를 빼 전체로 돌아가면 그 사실(누른 단추가 '눌림'으로 남아 거꾸로 동작한 것처럼 들리지 않게).
    expect(within(group).getByRole("status").textContent).toBe("분석 대상 2곳 / 3곳");
    fireEvent.click(within(group).getByRole("button", { name: "가상 자산운용 (Synthetic AM)" }));
    expect(within(group).getByRole("status").textContent).toBe("분석 대상 1곳 / 3곳");
    fireEvent.click(within(group).getByRole("button", { name: "가상 국부펀드" }));
    expect(pressed().every(([, state]) => state === "true")).toBe(true);
    expect(within(panel).getByText("3곳 / 3곳")).toBeTruthy();
    expect(within(group).getByRole("status").textContent).toBe("마지막 기관을 빼서 전체로 돌아갔습니다 — 분석 대상 3곳 / 3곳");
  });

  it("기관 목록을 읽는 동안은 자리표시, 읽지 못하면 오류와 '다시 시도'(누르면 목록만 한 번 더)", async () => {
    let fail = false;
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions")) return fail ? Promise.reject(new Error("기관 목록을 읽지 못했습니다.")) : new Promise(() => {});
      return new Promise(() => {});
    });
    const { unmount } = render(<ConsensusPage />);
    expect(await screen.findByRole("status", { name: "기관 목록 불러오는 중" })).toBeTruthy();
    unmount();

    fail = true;
    render(<ConsensusPage />);
    expect(await screen.findByText("기관 목록을 읽지 못했습니다.")).toBeTruthy();
    const institutionCalls = () => api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/sec13f/institutions")).length;
    const before = institutionCalls();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(institutionCalls()).toBe(before + 1));
  });
});

describe("교집합 — 읽기가 실패한 뒤 다시 읽는 동안(QA-710)", () => {
  // 수정 전 실패(plain it): { emptyText: true, listStatus: [], centerLoading: 0 } — useApi가 다시 읽을 때 failedAt을 남겨 firstLoadPending이 거짓이라, 기관 목록
  // 자리는 placeholder가 null이 되어 빈 목록 글을 그리고 가운데 칸은 아무것도 그리지 않음(개편 전에는 `loading && !data`의 '교집합을 계산하는 중…').
  it("기관 목록·교집합을 읽지 못한 뒤 '다시 시도'를 누르면 응답이 올 때까지 둘 다 '불러오는 중' — 기관 목록 자리에 '고를 기관이 없습니다.'가 없다", async () => {
    let fail = true;
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/sec13f/institutions") || path.startsWith("/api/sec13f/consensus")) {
        return fail ? Promise.reject(new Error("읽지 못했습니다.")) : new Promise(() => {});
      }
      return new Promise(() => {});
    });
    render(<ConsensusPage />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(2));
    fail = false;
    for (const button of screen.getAllByRole("button", { name: "다시 시도" })) fireEvent.click(button);
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "다시 시도" })).toHaveLength(0));

    // 기관 목록 자리 — 모르는 상태를 '없다'로 적지 않고 읽는 중 자리표시(처음 읽기와 같은 이름). 가운데 칸 — 실패 뒤 다시 읽는 동안은 공용
    // '불러오는 중' 한 줄(QA-655 규칙 — 처음 읽기의 KPI 자리표시가 아님).
    const group = screen.getByRole("group", { name: "분석 대상 기관" });
    expect({
      emptyText: group.textContent?.includes("고를 기관이 없습니다."),
      listStatus: within(group).queryAllByRole("status").map((status) => status.getAttribute("aria-label")),
      centerLoading: screen.queryAllByText("교집합을 계산하는 중…").length,
    }).toEqual({ emptyText: false, listStatus: ["기관 목록 불러오는 중"], centerLoading: 1 });
  });
});

describe("교집합 — 처음 읽는 동안 값이 온 뒤의 꼴로 자리를 잡는다(QA-714)", () => {
  // 수정 전 실패(plain it): { tags: 0, rows: 0, bars: false, table: false } — 기관 목록 자리는 글 줄 Skeleton 4줄, 가운데는 KPI 띠 자리표시뿐이라 값이 오면
  // 목록(390 672px·lg 824px)이 왼쪽 '조건'을, 막대·상세 표 패널이 '이번 분기 공통 신규 매수'를 화면 밖으로 밀었음(검토 자기 빌드 CLS 0.18~0.41).
  it("기관 목록은 목록 꼴 자리(좁은 화면 태그·넓은 화면 줄 12), 가운데는 막대·상세 표 패널 자리 — 값이 와도 아래 패널이 밀리지 않게", async () => {
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
    render(<ConsensusPage />);
    const group = await screen.findByRole("group", { name: "분석 대상 기관" });
    const status = within(group).getByRole("status", { name: "기관 목록 불러오는 중" });
    const lists = [...status.querySelectorAll("ul")];
    expect({
      tags: lists[0]?.children.length ?? 0,
      rows: lists[1]?.children.length ?? 0,
      bars: screen.queryByRole("status", { name: "공통 보유 상위 종목 불러오는 중" }) !== null,
      table: screen.queryByRole("status", { name: "교집합 상세 불러오는 중" }) !== null,
    }).toEqual({ tags: 12, rows: 12, bars: true, table: true });
  });
});

/** 스타일 화면 위험 응답(합성) — 위험 기여 하나는 음수(분산 효과로 포트폴리오 변동성을 줄이는 종목), VaR·ES는 손실이라 음수. */
function riskBody(over: Record<string, unknown> = {}) {
  return {
    available: true, cik: "0001067983", benchmark: "SPY", years: 1, collectedAtKst: "2026-11-04 19:40 KST", ageSeconds: 60, stale: false,
    coverage: { holdings: 30, totalHoldings: 40, weight: 78.1, totalWeight: 100, uncovered: [], uncoveredCount: 0 },
    metrics: { volatility: 14.2, var95: -1.13, var99: -1.92, es95: -1.63, es99: -2.27, maxDrawdown: 7.64, beta: 0.82, trackingError: 6.1, samples: 250,
      from: "2025-11-04", to: "2026-11-04" },
    contributions: [
      { ticker: "SYNA", name: "SYNTHETIC ALPHA CO", sector: "Technology", weight: 22.1, volatility: 24.0, marginal: 0.3, contribution: 4.1, share: 28.9 },
      { ticker: "SYNG", name: "SYNTHETIC GOLD CO", sector: "Materials", weight: 5.0, volatility: 18.0, marginal: -0.1, contribution: -0.42, share: -3.0 },
    ],
    sectors: [{ sector: "Technology", weight: 40.2 }],
    ...over,
  };
}

describe("스타일 — 종목별 위험 기여는 등락이 아니다(QA-704)", () => {
  // 수정 전 실패: 위험 기여 칸이 deltaColor로 양수 빨강(text-up)·음수 파랑(text-down)이고 음수 부호가 ASCII '-'('-0.42%p') — 기여는 오르내린 값이 아님.
  it("위험 기여·기여 비중 칸에 상승·하락 글자색이 없고 음수는 −(U+2212)", async () => {
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/guru/risk") ? Promise.resolve(riskBody()) : new Promise(() => {})));
    render(<GuruPage />);
    const table = (await screen.findByText("SYNTHETIC GOLD CO")).closest("table") as HTMLElement;
    const tinted = [...table.querySelectorAll(".text-up, .text-down")].map((element) => `${element.className} '${element.textContent}'`);
    // 칸마다 봅니다(표 글 전체를 이으면 칸 경계가 사라져 앞 칸 끝 글자에 붙은 '-'를 놓침).
    const hyphen = [...table.querySelectorAll("td, th")].map((cell) => cell.textContent ?? "").filter((text) => /(^|\s)-\d/.test(text));
    expect({ tinted, hyphen }).toEqual({ tinted: [], hyphen: [] });
    expect(within(table).getByText("−0.42%p")).toBeTruthy();
    expect(within(table).getByText("−3.0%")).toBeTruthy();
  });
});

describe("스타일 — 위험 지표 VaR·ES의 음수 부호(QA-709)", () => {
  // 수정 전 실패: VaR·ES 값이 formatWithUnit 글 그대로라 '-1.13%'·'-1.92%'·'-1.63%'·'-2.27%'(ASCII 하이픈) — 화면의 다른 음수는 −(U+2212).
  it("VaR(95·99%)·ES(95·99%)의 음수 값은 −(U+2212)로 적는다", async () => {
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/guru/risk") ? Promise.resolve(riskBody()) : new Promise(() => {})));
    render(<GuruPage />);
    await screen.findByText("SYNTHETIC GOLD CO");
    const shown = ["VaR (95%)", "VaR (99%)", "ES (95%)", "ES (99%)"].map((label) => {
      // 이름 글의 부모(지표 칸·KPI 타일) 안의 글 — 이름·값·보조 글.
      const tile = screen.getByText(label).parentElement as HTMLElement;
      return `${label}: ${(tile.textContent ?? "").replace(label, "")}`;
    });
    expect(shown.filter((text) => /-\d/.test(text))).toEqual([]);
    expect(shown.map((text) => text.match(/−\d[\d.]*%/)?.[0] ?? null)).toEqual(["−1.13%", "−1.92%", "−1.63%", "−2.27%"]);
  });
});

/** 스타일 화면 유사도 응답(합성 — 기관 셋, 이름은 백엔드처럼 국기 + 괄호 영문). */
const SIMILARITY_BODY = {
  available: true, note: "겹침 비중·코사인 — 최신 분기 기준",
  institutions: [
    { cik: "0000000021", key: "a", name: "🇺🇸 가상 자산운용 (Synthetic Asset Management)", reportDate: "2026-06-30" },
    { cik: "0000000022", key: "b", name: "🇳🇴 가상 국부펀드 (Synthetic Sovereign Fund)", reportDate: "2026-06-30" },
    { cik: "0000000023", key: "c", name: "🇰🇷 가상 연기금 (Synthetic Pension)", reportDate: "2026-06-30" },
  ],
  overlap: [[100, 42.5, 12.25], [42.5, 100, 0], [12.25, 0, 100]],
  cosine: [[1, 0.81, 0.2], [0.81, 1, 0.05], [0.2, 0.05, 1]],
  topPairs: [],
};

/** '가장 닮은 짝' 표 — 그 제목(h3) 다음에 오는 첫 표(뒤의 유사도 행렬보다 앞). */
async function pairsTable(): Promise<HTMLTableElement> {
  const heading = await screen.findByText(/^가장 닮은 짝/, { selector: "h3" });
  return heading.parentElement?.querySelector("table") as HTMLTableElement;
}

describe("스타일 — '가장 닮은 짝' 표가 좁은 화면에서 패널 밖으로 넘친다(QA-706)", () => {
  // 수정 전 실패(D1 QA — 390에서 값 끝이 잘리고 막대가 0폭, 가로 스크롤 없음)의 구조: 표가 가로 스크롤 상자 밖, 열 넷(#·기관 A·기관 B·값),
  // 두 이름 칸이 줄바꿈 금지(whitespace-nowrap)라 표가 패널 폭보다 넓어짐.
  it("짝 표는 가로 스크롤 상자 안의 세 칸 표(#·짝·값)이고 이름 칸은 줄을 바꿀 수 있다", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/similarity") ? Promise.resolve(SIMILARITY_BODY) : new Promise(() => {}));
    render(<GuruPage />);
    const table = await pairsTable();
    const region = table.closest('[role="region"]');
    const nowrapNames = [...table.querySelectorAll("tbody .whitespace-nowrap")]
      .map((cell) => cell.textContent ?? "")
      .filter((text) => /[가-힣A-Za-z]/.test(text));
    expect({
      region: region?.getAttribute("aria-label") ?? null,
      headers: [...table.querySelectorAll("thead th")].map((cell) => cell.textContent),
      nowrapNames,
    }).toEqual({
      region: "가장 닮은 짝 — 겹침 비중 순 상위 3 (좌우 스크롤)",
      headers: ["#순위", "짝", "겹침 비중 (%)"],
      nowrapNames: [],
    });
    // 순위 열 머리는 보이는 기호 '#'(장식)와 낭독 이름 '순위'
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent === "#순위" && cell.querySelector('[aria-hidden="true"]')?.textContent === "#")).toEqual([
      true,
      false,
      false,
    ]);
    expect(within(table).getByRole("columnheader", { name: "순위" })).toBeTruthy();
  });
});

describe("스타일 — '가장 닮은 짝' 막대가 고대비에서 사라진다(QA-708)", () => {
  // 수정 전 실패: 막대(바탕 surface-2 + 채움 text-3)가 바탕색만으로 그린 모양이라 고대비(forced-colors)에서 바탕색이 지워지면 통째로 사라짐 —
  // 막대 상자에 forced-color-adjust-none이 없음(D1 '바탕색만으로 그린 모양'의 /style 몫).
  it("짝 막대(장식)는 고대비에서도 색을 지키고(forced-color-adjust-none), 숫자는 막대 밖 글로 남는다", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/similarity") ? Promise.resolve(SIMILARITY_BODY) : new Promise(() => {}));
    render(<GuruPage />);
    const table = await pairsTable();
    const bars = [...table.querySelectorAll('tbody [aria-hidden="true"]')].filter((element) => element.querySelector("span") !== null);
    expect(bars).toHaveLength(3);
    expect(bars.map((bar) => (bar.getAttribute("class") ?? "").split(/\s+/).includes("forced-color-adjust-none"))).toEqual([true, true, true]);
    expect([...table.querySelectorAll("tbody tr")].map((row) => row.lastElementChild?.textContent)).toEqual(["42.5", "12.3", "0.0"]);
  });
});

describe("스타일 — 기관 간 유사도 행렬이 계열 파랑 농도로 칠해진다(QA-707)", () => {
  // 수정 전 실패: 칸이 인라인 rgba(57, 135, 229, 0.08~0.63)(계열 파랑 #3987e5 — 강조 파랑과 ΔE 3.4, 명세 §3-5 '순차는 accent·up·down과 다른 계열' 위반)이고
  // 대각선이 인라인 rgba(139, 148, 158, 0.12)(토큰 밖 회색), 단계 범례가 없음.
  it("칸은 순차 팔레트 단계(data-step — 겹침 비중이면 최댓값 100의 비율), 대각선(자기 자신)은 중립 면, 0은 칠하지 않고, 단계 범례가 있다", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/similarity") ? Promise.resolve(SIMILARITY_BODY) : new Promise(() => {}));
    render(<GuruPage />);
    const matrix = await screen.findByRole("region", { name: "기관 간 유사도 행렬 (좌우 스크롤)" });
    const cells = [...matrix.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td.tabular-nums")].map((cell) => {
        const element = cell as HTMLElement;
        return element.getAttribute("data-step") ?? (element.classList.contains("bg-surface-2") ? "self" : element.style.backgroundColor || "none");
      }));
    expect({
      cells,
      rgba: (matrix.innerHTML.match(/rgba\([^)]*\)/g) ?? []).length,
      legend: within(matrix).queryByRole("list", { name: "칸 색 단계" }) !== null,
    }).toEqual({
      // 42.5 → 0.425(단계 3), 12.25 → 0.1225(단계 1), 0 → 칠하지 않음.
      cells: [["self", "3", "1"], ["3", "self", "none"], ["1", "none", "self"]],
      rgba: 0,
      legend: true,
    });
  });
});

describe("스타일 — 머리 '새로고침'·13F 한계 안내·'읽는 법' 접기", () => {
  it("'성격 새로고침'은 화면 머리(h1과 같은 머리)의 동작이고 이름은 '기관별 성격 새로고침'(보이는 글을 담음), 읽는 동안 aria-busy, 누르면 기관별 성격만 한 번 더", async () => {
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
    render(<GuruPage />);
    const button = screen.getByRole("button", { name: "기관별 성격 새로고침" });
    // 보이는 글에도 다시 읽는 범위(기관별 성격 응답 하나)를 적습니다 — 예전 '새로고침'만으로는 화면 전체로 읽혔음(P5b 검토 지적).
    expect(button.textContent).toBe("성격 새로고침");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.closest("header")?.querySelector("h1")?.textContent).toBe("기관 13F 스타일·위험");
    // 성격 패널 머리에는 단추가 없습니다(머리 동작으로 옮김).
    const panel = screen.getByRole("heading", { name: "기관별 성격" }).closest("section") as HTMLElement;
    expect(within(panel).queryByRole("button", { name: /새로고침/ })).toBeNull();
    const profiles = () => api.apiGetShared.mock.calls.filter(([path]) => path === "/api/guru/profiles").length;
    const before = profiles();
    fireEvent.click(button);
    await waitFor(() => expect(profiles()).toBe(before + 1));
  });

  it("13F 공시의 한계는 제목 있는 중립 안내 상자로 늘 보이고, 긴 설명 셋은 처음에 접힌 '읽는 법'", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path === "/api/guru/profiles") {
        return Promise.resolve({ available: true, note: "13F 저장본 기준", rows: [{ cik: "0000000031", key: "a", name: "가상 자산운용", desc: "합성", reportDate: "2026-06-30",
          totalValue: 1e9, holdingCount: 10, effectiveHoldings: 5.5, hhi: 0.18, top10Weight: 90, turnover: null, quarterCount: 1 }] });
      }
      if (path.startsWith("/api/guru/similarity")) return Promise.resolve(SIMILARITY_BODY);
      if (path.startsWith("/api/guru/risk")) return Promise.resolve(riskBody());
      return new Promise(() => {});
    });
    render(<GuruPage />);
    expect(screen.getByText("13F 공시의 한계")).toBeTruthy();
    expect(screen.getByText(/미국 상장 롱 포지션만/)).toBeTruthy();
    await screen.findByText("SYNTHETIC GOLD CO");
    await screen.findByRole("region", { name: "기관 간 유사도 행렬 (좌우 스크롤)" });
    const guides = [...document.querySelectorAll("details")].filter((details) => details.querySelector("summary")?.textContent?.startsWith("읽는 법"));
    expect(guides.map((details) => [details.querySelector("summary")?.textContent, details.open])).toEqual([
      ["읽는 법 — 유효 종목 수·회전율", false],
      ["읽는 법 — 겹침 비중·코사인", false],
      ["읽는 법 — 위험 기여", false],
    ]);
    expect(guides[0].textContent).toContain("1 ÷ 허핀달 지수");
  });
});

describe("스타일 — 기관별 성격 표와 검사 칸", () => {
  const PROFILE_ROWS = [
    { cik: "0000000031", key: "a", name: "🇺🇸 가상 자산운용 (Synthetic AM)", desc: "합성 소개 — 가치 투자", reportDate: "2026-06-30", totalValue: 2.5e11,
      holdingCount: 40, effectiveHoldings: 8.24, hhi: 0.1214, top10Weight: 88.12, turnover: null, quarterCount: 8 },
    { cik: "0000000032", key: "b", name: "가상 연기금", desc: "", reportDate: null, totalValue: null, holdingCount: 700, effectiveHoldings: null, hhi: 0,
      top10Weight: 40.2, turnover: 12.5, quarterCount: 1 },
  ];

  it("표는 기관 이름(검사 단추)·총액·종목 수·유효 종목 수·상위 10종목·회전율·기준 분기 — 소개 글은 표에 없고, 모르는 값은 '—'(회전율은 까닭)", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path === "/api/guru/profiles" ? Promise.resolve({ available: true, note: "13F 저장본 기준", rows: PROFILE_ROWS }) : new Promise(() => {}));
    render(<GuruPage />);
    const trigger = await screen.findByRole("button", { name: "가상 자산운용 (Synthetic AM)" });
    const table = trigger.closest("table") as HTMLElement;
    expect([...table.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
      "기관", "포트폴리오 총액", "종목 수", "유효 종목 수", "상위 10종목", "분기 회전율", "기준 분기",
    ]);
    expect(within(table).queryByText("합성 소개 — 가치 투자")).toBeNull();
    const [first, second] = [...table.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent));
    expect(first).toEqual(["가상 자산운용 (Synthetic AM)", "2,500억 달러", "40", "8.21 ÷ HHI", "88.1%", "—값 없음직전 분기 없음", "2026-06-30"]);
    expect(second).toEqual(["가상 연기금", "—값 없음", "700", "—값 없음", "40.2%", "12.5%", "—값 없음"]);
    expect(within(table).getByTitle("직전 분기가 없어 계산할 수 없습니다")).toBeTruthy();
    // 패널 머리 개수.
    const panel = screen.getByRole("heading", { name: "기관별 성격" }).closest("section") as HTMLElement;
    expect(within(panel).getByText("2곳")).toBeTruthy();
  });

  it("기관 이름을 누르면 검사 칸(좁은 화면 대화상자)에 소개·CIK·HHI·수집 분기 수와 '기관 상세 열기', 닫으면 그 이름 단추로 포커스", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path === "/api/guru/profiles" ? Promise.resolve({ available: true, rows: PROFILE_ROWS }) : new Promise(() => {}));
    render(<GuruPage />);
    const trigger = await screen.findByRole("button", { name: "가상 자산운용 (Synthetic AM)" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "가상 자산운용 (Synthetic AM)" });
    const value = (label: string) => within(dialog).getByText(label).nextElementSibling?.textContent;
    expect(value("CIK")).toBe("0000000031");
    expect(value("HHI")).toContain("0.1214");
    expect(value("수집 분기 수")).toBe("8분기");
    expect(value("분기 회전율")).toContain("직전 분기가 없어 계산할 수 없습니다");
    expect(within(dialog).getByText("합성 소개 — 가치 투자")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "기관 상세 열기" }).getAttribute("href")).toBe("/institutions/0000000031");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("읽는 중·읽지 못함(다시 시도)·저장본 없음", async () => {
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
    const view = render(<GuruPage />);
    // 처음 읽는 동안은 표 꼴 자리(QA-715 — 예전 '13F 저장본을 읽는 중…' 한 줄).
    expect(screen.getByRole("status", { name: "기관별 성격 불러오는 중" })).toBeTruthy();
    view.unmount();

    api.apiGetShared.mockImplementation((path: string) =>
      path === "/api/guru/profiles" ? Promise.reject(new Error("성격을 읽지 못했습니다.")) : new Promise(() => {}));
    const failed = render(<GuruPage />);
    expect((await screen.findAllByText("성격을 읽지 못했습니다.")).length).toBeGreaterThan(0);
    failed.unmount();

    api.apiGetShared.mockImplementation((path: string) =>
      path === "/api/guru/profiles" ? Promise.resolve({ available: false, message: "13F 저장본이 없습니다.", rows: [] }) : new Promise(() => {}));
    render(<GuruPage />);
    expect(await screen.findByText("13F 저장본이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "기관별 성격" })).toBeNull();
  });
});

describe("스타일 — 기관별 성격을 처음 읽는 동안 값이 온 뒤의 꼴로 자리를 잡는다(QA-715)", () => {
  // 수정 전 실패(plain it): { rows: 0, subtitle: false } — 처음 읽는 동안 패널 본문은 '13F 저장본을 읽는 중…' 한 줄(68px)이고 부제가 없어, 값이 오면 부제(응답 글 +
  // 안내 — 1024 이상 두 줄)와 표(1440 640px·390 1,195px)가 생기며 아래 '기관 간 유사도'·'포트폴리오 위험'을 밀었음(검토 자기 빌드 CLS 1440 0.5199).
  it("표 꼴 자리(머리 + 줄 12)와 값이 온 뒤와 같은 부제 — 응답 글(note)은 부제가 아니라 표 아래", async () => {
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
    const view = render(<GuruPage />);
    const panel = screen.getByRole("heading", { level: 2, name: "기관별 성격" }).closest("section") as HTMLElement;
    const pending = within(panel).queryByRole("status", { name: "기관별 성격 불러오는 중" });
    const hint = "기관 이름을 누르면 소개·HHI·수집 분기 수와 기관 상세 링크를 봅니다.";
    expect({
      rows: pending ? pending.querySelectorAll("li").length : 0,
      subtitle: within(panel).queryByText(hint) !== null,
    }).toEqual({ rows: 12, subtitle: true });
    view.unmount();

    api.apiGetShared.mockImplementation((path: string) =>
      path === "/api/guru/profiles"
        ? Promise.resolve({ available: true, note: "합성 응답 글 — 13F 한계", rows: [{ cik: "0000000031", key: "a", name: "가상 자산운용", desc: "", reportDate: "2026-06-30",
            totalValue: 1e9, holdingCount: 10, effectiveHoldings: 5.5, hhi: 0.18, top10Weight: 90, turnover: 3, quarterCount: 2 }] })
        : new Promise(() => {}));
    render(<GuruPage />);
    await screen.findByRole("button", { name: "가상 자산운용" });
    const loaded = screen.getByRole("heading", { level: 2, name: "기관별 성격" }).closest("section") as HTMLElement;
    const subtitle = within(loaded).getByText(hint);
    expect(subtitle.textContent).toBe(hint);
    const note = within(loaded).getByText("합성 응답 글 — 13F 한계");
    expect(note.compareDocumentPosition(within(loaded).getByRole("table")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});

describe("스타일 — 포트폴리오 위험 KPI 띠·기여 표·보유 기관 표·'/' 표지", () => {
  it("위험 지표는 KPI 띠 여덟 타일(첫 타일 보조 글 '표본 n일 · 시작 ~ 끝'), 모르는 값은 '—'(0으로 채우지 않음)", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/risk")
        ? Promise.resolve(riskBody({ metrics: { volatility: 14.2, var95: -1.13, var99: null, es95: -1.63, es99: -2.27, maxDrawdown: 7.64, beta: 0.82, trackingError: 6.1,
          samples: 250, from: "2025-11-04", to: "2026-11-04" } }))
        : new Promise(() => {}));
    render(<GuruPage />);
    const strip = await screen.findByRole("region", { name: "위험 지표" });
    const tiles = within(strip).getAllByRole("group");
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "연율 변동성", "베타 (vs SPY)", "추적오차 (연율)", "최대낙폭", "VaR (95%)", "VaR (99%)", "ES (95%)", "ES (99%)",
    ]);
    expect(tiles[0].textContent).toContain("14.20%");
    expect(tiles[0].textContent).toContain("표본 250일 · 2025-11-04 ~ 2026-11-04");
    expect(tiles[5].textContent).toContain("값 없음");
    expect(tiles[5].textContent).not.toContain("0.00");
    // 등락색 없음 — 위험의 크기라 본문 잉크.
    expect(strip.querySelectorAll(".text-up, .text-down")).toHaveLength(0);
  });

  it("보유 기관 검색 결과는 공용 표(개수 줄 'n건'), 입력은 셸 '/' 표지 — 화면에 하나(교집합·스코어카드에는 없음)", async () => {
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/guru/holders") ? Promise.resolve(holders()) : new Promise(() => {})));
    const view = render(<GuruPage />);
    const input = screen.getByPlaceholderText("NVIDIA");
    expect(document.querySelectorAll("[data-shell-filter]")).toHaveLength(1);
    expect(input.hasAttribute("data-shell-filter")).toBe(true);
    fireEvent.change(input, { target: { value: QUERY } });
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    const table = await screen.findByRole("table", { name: "이 종목을 누가 들고 있나 — 찾은 보유 줄" });
    expect(within(table).getAllByText("CUSIP 000000201")).toHaveLength(2);
    const card = screen.getByRole("heading", { name: "이 종목을 누가 들고 있나" }).closest("section") as HTMLElement;
    expect(within(card).getByText("2건")).toBeTruthy();
    view.unmount();

    render(<ConsensusPage />);
    expect(document.querySelectorAll("[data-shell-filter]")).toHaveLength(0);
  });
});

/** 스코어카드 응답(합성) — 지표 다섯(모멘텀 하나는 음수, 변동성·최대낙폭은 양수 크기), 원자료 1개월 수익률 −0.297(QA 자료와 같은 값). */
function scorecardBody(over: Record<string, unknown> = {}) {
  return {
    available: true, symbol: "SYNQ", name: "Synthetic Quote Inc.", sector: "Technology", benchmark: "SPY", years: 1, universeLabel: "S&P 500 대형주",
    universeSize: 136, missing: ["재무 안정성", "성장성"], caveat: "가격으로 잴 수 있는 것만 담은 카드입니다.", collectedAtKst: "2026-11-04 19:40 KST", ageSeconds: 60,
    stale: false,
    metrics: [
      { label: "12개월 모멘텀", how: "12개월 수익률(최근 1개월 제외)", value: -5.2, unit: "%", score: 31, direction: "높을수록 좋음" },
      { label: "3개월 모멘텀", how: "3개월 수익률", value: 4.4, unit: "%", score: 62, direction: "높을수록 좋음" },
      { label: "변동성", how: "연율 표준편차", value: 23.4, unit: "%", score: 40, direction: "낮을수록 좋음" },
      { label: "최대낙폭", how: "구간 고점 대비 최대 하락", value: 13.8, unit: "%", score: 55, direction: "낮을수록 좋음" },
      { label: "추세 위치", how: "200일 이동평균 대비", value: null, unit: "%", score: null, direction: "높을수록 좋음" },
    ],
    priceScore: 47, scoredCount: 4, raw: { momentum1m: -0.297, momentum6m: 4.1, beta: 1.12, samples: 250 },
    ...over,
  };
}

describe("스코어카드 — 주의 안내가 처음 읽는 동안과 값이 온 뒤 같은 꼴이다(QA-716)", () => {
  /** 백엔드 ScorecardService가 늘 보내는 글·목록(응답과 같은 값 — 화면이 처음 읽는 동안 둘 자리의 기준). */
  const CAVEAT = "가격으로 잴 수 있는 것만 담은 카드입니다. 종합 점수가 아니며, 재무가 부실한 회사도 주가가 오르면 높은 점수를 받습니다.";
  const MISSING = ["재무 안정성 (부채비율·이자보상배율)", "성장성 (매출·이익 증가율)", "밸류에이션 (PER·PBR·배당수익률)"];
  /** 주의 안내 상자 — 본문 글(첫 줄)과 빠진 것 목록의 줄 수(값 줄 또는 자리 줄). */
  function callout() {
    const box = screen.getByText("이 카드는 종합 점수가 아닙니다.").closest("div.rounded-control") as HTMLElement;
    const list = box.querySelector("ul");
    return { caveat: box.querySelector("div.mt-1")?.textContent ?? null, lines: list ? list.children.length : 0 };
  }

  // 수정 전 실패(plain it): { sameCaveat: false, pendingLines: 0, loadedLines: 3 } — 처음 읽는 동안의 본문 글(화면의 대체 글)이 응답 글보다 짧고('종합 점수가 아니며,'
  // 없음) 빠진 것 목록이 응답이 와야 생겨, 값이 오면 안내 상자가 자라 아래 조회 조건·결과를 밀었음(검토 자기 빌드 CLS 390 0.1905·1024 0.054).
  it("처음 읽는 동안 본문 글은 응답과 같은 글이고 빠진 것 목록 자리가 응답과 같은 줄 수", async () => {
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
    const view = render(<ScorecardPage />);
    const pending = callout();
    view.unmount();
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/stock/scorecard") ? Promise.resolve(scorecardBody({ caveat: CAVEAT, missing: MISSING })) : new Promise(() => {}));
    render(<ScorecardPage />);
    await screen.findByRole("region", { name: "스코어 요약" });
    const loaded = callout();
    expect({ sameCaveat: pending.caveat === loaded.caveat, pendingLines: pending.lines, loadedLines: loaded.lines }).toEqual({
      sameCaveat: true,
      pendingLines: 3,
      loadedLines: 3,
    });
  });
});

describe("스코어카드 — 처음 읽는 동안 빠진 것 목록이 응답과 같은 글이다(QA-721)", () => {
  /** 백엔드 ScorecardService가 늘 보내는 빠진 것 목록(응답과 같은 값). */
  const MISSING = ["재무 안정성 (부채비율·이자보상배율)", "성장성 (매출·이익 증가율)", "밸류에이션 (PER·PBR·배당수익률)"];
  function missingTexts() {
    const box = screen.getByText("이 카드는 종합 점수가 아닙니다.").closest("div.rounded-control") as HTMLElement;
    return [...(box.querySelector("ul")?.children ?? [])].map((item) => item.textContent ?? "");
  }

  // 수정 전 실패(plain it): 처음 읽는 동안의 줄 글이 ['', '', ''](글 없는 막대 자리 — QA-716 고침). 줄 수는 같지만 390에서 실제 줄 셋 가운데 둘이 두 줄로 꺾여
  // 안내 상자가 181 → 213px로 자랐음(검토 자기 빌드, 지연 300ms — CLS 0.1905 그대로). 같은 글이면 같은 폭에서 같은 줄로 꺾입니다.
  it("처음 읽는 동안의 빠진 것 목록 줄 글이 응답이 온 뒤와 같다", async () => {
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
    const view = render(<ScorecardPage />);
    const pending = missingTexts();
    view.unmount();
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/stock/scorecard") ? Promise.resolve(scorecardBody({ missing: MISSING })) : new Promise(() => {}));
    render(<ScorecardPage />);
    await screen.findByRole("region", { name: "스코어 요약" });
    expect({ pending, loaded: missingTexts() }).toEqual({
      pending: MISSING.map((item) => `${item} — 수집하지 않습니다`),
      loaded: MISSING.map((item) => `${item} — 수집하지 않습니다`),
    });
  });
});

describe("스코어카드 — 실제 값은 등락이 아니다(QA-705)", () => {
  // 수정 전 실패: '실제 값' 칸이 deltaColor라 양수인 변동성·최대낙폭까지 상승 빨강(text-up)·음수 모멘텀은 하락 파랑이고, 음수 부호가 ASCII '-'
  // (표 '-5.2%', 원자료 1개월 수익률 '-0.30%').
  it("지표 표의 실제 값 칸에 상승·하락 글자색이 없고, 표·원자료의 음수는 −(U+2212)", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/stock/scorecard") ? Promise.resolve(scorecardBody()) : new Promise(() => {}));
    render(<ScorecardPage />);
    const table = (await screen.findByText("변동성")).closest("table") as HTMLElement;
    const tinted = [...table.querySelectorAll(".text-up, .text-down")].map((element) => `${element.className} '${element.textContent}'`);
    const hyphen = [...table.querySelectorAll("td, th")].map((cell) => cell.textContent ?? "").filter((text) => /(^|\s)-\d/.test(text));
    const raw = (screen.getByText("1개월 수익률").parentElement as HTMLElement).textContent?.replace("1개월 수익률", "") ?? "";
    expect({ tinted, hyphen, raw }).toEqual({ tinted: [], hyphen: [], raw: "−0.30%" });
  });
});

describe("스코어카드 — 배치와 네 상태", () => {
  const scorecardOnly = (answer: () => Promise<unknown>) =>
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/stock/scorecard") ? answer() : new Promise(() => {})));

  it("'종합 점수가 아닙니다' 주의 안내가 결과보다 먼저(늘 보임), 스코어 요약의 종목 타일은 종목 상세 링크, 표는 지표·실제 값·백분위·방향", async () => {
    scorecardOnly(() => Promise.resolve(scorecardBody()));
    render(<ScorecardPage />);
    const strip = await screen.findByRole("region", { name: "스코어 요약" });
    const caution = screen.getByText("이 카드는 종합 점수가 아닙니다.");
    // 문서 차례: 주의 안내 → 조회 조건 → 요약 띠.
    expect(caution.compareDocumentPosition(screen.getByLabelText("종목")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("종목").compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("재무 안정성 — 수집하지 않습니다")).toBeTruthy();

    const link = within(strip).getByRole("link");
    expect(link.getAttribute("href")).toBe("/s/us/SYNQ");
    expect(link.textContent).toContain("Synthetic Quote Inc. · Technology");
    expect(within(strip).getByRole("group", { name: "가격 지표 평균" }).textContent).toContain("47점");
    expect(within(strip).getByRole("group", { name: "비교 대상" }).textContent).toContain("136종목");

    const table = screen.getByRole("table", { name: "지표별 점수" });
    expect([...table.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["지표", "실제 값", "백분위", "방향"]);
    const trend = [...table.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent))[4];
    expect(trend).toEqual(["추세 위치200일 이동평균 대비", "—값 없음", "—값 없음표본 부족", "높을수록 좋음"]);
    expect(within(table).getByTitle("표본이 부족해 값을 잴 수 없어 백분위도 없습니다")).toBeTruthy();
    const raw = screen.getByRole("region", { name: "원자료" });
    expect(within(raw).getByRole("group", { name: "측정 구간" }).textContent).toContain("최근 1년");
  });

  it("읽는 중·읽지 못함(다시 시도 +1)·저장본 없음 — 주의 안내와 조회 조건은 늘 그대로", async () => {
    scorecardOnly(() => new Promise(() => {}));
    const view = render(<ScorecardPage />);
    expect(screen.getByText("스코어카드를 계산하는 중…")).toBeTruthy();
    expect(screen.getByText("이 카드는 종합 점수가 아닙니다.")).toBeTruthy();
    view.unmount();

    scorecardOnly(() => Promise.reject(new Error("스코어카드를 읽지 못했습니다.")));
    const failed = render(<ScorecardPage />);
    expect(await screen.findByText("스코어카드를 읽지 못했습니다.")).toBeTruthy();
    const scorecardCalls = () => api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/stock/scorecard")).length;
    const before = scorecardCalls();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(scorecardCalls()).toBe(before + 1));
    failed.unmount();

    scorecardOnly(() => Promise.resolve({ available: false, message: "SYNQ 가격 이력이 없습니다.", symbol: "SYNQ", name: null, sector: null, benchmark: "SPY",
      years: 1, universeLabel: "S&P 500 대형주", missing: [], caveat: "가격으로 잴 수 있는 것만 담은 카드입니다." }));
    render(<ScorecardPage />);
    expect(await screen.findByText("SYNQ 가격 이력이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "스코어 요약" })).toBeNull();
    expect(screen.getByLabelText("베타 기준")).toBeTruthy();
  });

  it("모르는 점수·비교 대상 수·베타는 '—'(0으로 채우지 않음)", async () => {
    scorecardOnly(() => Promise.resolve(scorecardBody({ priceScore: null, scoredCount: undefined, universeSize: undefined,
      raw: { momentum1m: null, momentum6m: null, beta: null, samples: 0 } })));
    render(<ScorecardPage />);
    const strip = await screen.findByRole("region", { name: "스코어 요약" });
    for (const name of ["가격 지표 평균", "베타 (vs SPY)", "비교 대상"]) {
      const tile = within(strip).getByRole("group", { name });
      expect(tile.textContent).toContain("값 없음");
      expect(tile.textContent).not.toMatch(/(^|[^\d])0(점|종목)/);
    }
  });
});

describe("스타일 — 보유 기관 검색 오류는 검색 칸 줄과 띄운다", () => {
  it("읽지 못하면 오류 상자(다시 시도)가 12px(mt-3) 띄운 자리에 — 위험 패널의 오류와 같은 간격", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/guru/holders") ? Promise.reject(new Error("보유 기관을 읽지 못했습니다.")) : new Promise(() => {}));
    render(<GuruPage />);
    fireEvent.change(screen.getByPlaceholderText("NVIDIA"), { target: { value: "NVIDIA" } });
    fireEvent.click(screen.getByRole("button", { name: "찾기" }));
    const message = await screen.findByText("보유 기관을 읽지 못했습니다.");
    const box = message.closest("div.rounded-control") as HTMLElement;
    expect(box.parentElement?.className).toBe("mt-3");
  });
});

describe("모르는 값 '—'의 까닭을 늘 보이는 글로 적는다(QA-719)", () => {
  // 수정 전 실패(plain it): { turnover: "—값 없음", percentile: "—값 없음" } — 까닭은 칸 span의 title(마우스 설명)에만 있어 키보드·터치·낭독기로 닿지 않았고, 스타일
  // 회전율의 까닭 문단('직전 분기가 없으면 —')은 P5b에서 '읽는 법' 접기 안으로 들어가 늘 보이는 곳에 없었음.
  it("스타일 성격 표 회전율·스코어카드 백분위의 '—' 옆에 짧은 까닭(직전 분기 없음·표본 부족)", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path === "/api/guru/profiles"
        ? Promise.resolve({ available: true, rows: [{ cik: "0000000031", key: "a", name: "가상 자산운용", desc: "", reportDate: "2026-06-30", totalValue: 1e9,
            holdingCount: 10, effectiveHoldings: 5.5, hhi: 0.18, top10Weight: 90, turnover: null, quarterCount: 1 }] })
        : new Promise(() => {}));
    const style = render(<GuruPage />);
    const row = (await screen.findByRole("button", { name: "가상 자산운용" })).closest("tr") as HTMLElement;
    const table = row.closest("table") as HTMLElement;
    const turnoverIndex = [...table.querySelectorAll("thead th")].findIndex((cell) => cell.textContent === "분기 회전율");
    const turnover = row.children[turnoverIndex].textContent;
    // 까닭은 '—' 아래 줄(세로로 쌓음) — 옆에 두면 줄바꿈 없는 숫자 열이 넓어져 1024에서 표가 856 → 956px로 자랐음.
    expect((row.children[turnoverIndex].firstElementChild as HTMLElement).className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "flex-col", "items-end"]));
    style.unmount();

    api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/stock/scorecard") ? Promise.resolve(scorecardBody()) : new Promise(() => {})));
    render(<ScorecardPage />);
    const trend = (await screen.findByText("추세 위치")).closest("tr") as HTMLElement;
    const scoreTable = trend.closest("table") as HTMLElement;
    const scoreIndex = [...scoreTable.querySelectorAll("thead th")].findIndex((cell) => cell.textContent === "백분위");
    expect({ turnover, percentile: trend.children[scoreIndex].textContent }).toEqual({ turnover: "—값 없음직전 분기 없음", percentile: "—값 없음표본 부족" });
    expect((trend.children[scoreIndex].firstElementChild as HTMLElement).className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "flex-col", "items-end"]));
  });
});
