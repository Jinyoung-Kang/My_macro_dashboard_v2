/**
 * 매크로 화면(/macro)의 요청 목록 — 화면을 다시 짜도(작업대 화면 언어 P5a — 목차·지표 표·미리보기 검사 칸·원본 데이터 머리 동작) 서버에 묻는 것은
 * 그대로여야 합니다(실행 명세 §7 3행, 계획 §4 '요청 지킴 시험'). 개편 전 화면에서 먼저 통과시켜 두고 개편 커밋들이 그대로 통과합니다.
 *
 * 고정하는 것
 *  - 화면을 열 때 읽는 경로와 횟수(경로마다 한 번) — 회원과 운영자(운영자만 경제 캘린더).
 *  - 실시간 시세는 자동 갱신 간격으로 구독하는 SSE 하나(GET 경로가 아님), 간격을 1분보다 길게 고르면 개요를 live 없이 다시 읽고 SSE도 그 간격으로.
 *  - 원본 데이터(GET /api/snapshot/text)는 열 때 읽지 않고, '원본 데이터 보기'를 누를 때 한 번 더 — 복사는 공유 읽기가 아니라 한 번 읽기(apiGet).
 *  - 지표 미리보기(검사 칸·대화상자)는 이미 받은 개요만 씁니다 — 지표를 골라도 요청이 늘지 않습니다(스파크라인을 두지 않은 까닭).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "http://backend", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
const clipboard = vi.hoisted(() => ({ copyText: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/clipboard", () => clipboard);

import MacroPage from "../macro/page";
import { endpoints } from "@/lib/endpoints";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {}
}

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO" };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

const OVERVIEW = {
  available: true,
  collectedAtKst: "2026-11-17 06:30 KST",
  categories: [
    { id: "fx", title: "환율", items: [
      { key: "dxy", name: "달러 인덱스", status: "ok", priceStr: "99.50", deltaStr: "+0.10 (+0.10%)", delta: 0.1, pct: 0.1,
        prevStr: "99.40", delayMinutes: 0, source: "TradingView (TVC:DXY)", lastTs: "2026-11-17 06:30 KST" },
    ] },
  ],
};

const SNAPSHOT = { text: "원본 글", chars: 4, generatedAtKst: "2026-11-17 06:31 KST" };

/** 열 때 읽는 경로(회원) — 공유 읽기(useApi → apiGetShared). */
const MEMBER_PATHS = [
  endpoints.publicData.krHolidays,
  endpoints.macro.overview(true),
  endpoints.macro.risk,
  endpoints.macro.advanced,
  endpoints.macro.fred("T10Y3M", 10),
  endpoints.macro.fx(["usdkrw", "dxy"], "1y", "index"),
  endpoints.macro.ticker("^VIX", "1y"),
  endpoints.macro.scraped,
].sort();

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [path] of api.apiGetShared.mock.calls) out[path as string] = (out[path as string] ?? 0) + 1;
  return out;
}

function once(paths: readonly string[]): Record<string, number> {
  return Object.fromEntries([...paths].sort().map((path) => [path, 1]));
}

/** 첫 그리기 뒤 효과·응답이 모두 돈 다음의 요청 표. */
async function settled(): Promise<Record<string, number>> {
  await act(async () => {});
  await act(async () => {});
  return counts();
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  window.localStorage.clear();
  api.apiGet.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/macro/overview")) return Promise.resolve(OVERVIEW);
    if (path === endpoints.snapshot.text) return Promise.resolve(SNAPSHOT);
    return new Promise(() => {});
  });
  api.apiGet.mockImplementation((path: string) =>
    path === endpoints.snapshot.text ? Promise.resolve(SNAPSHOT) : new Promise(() => {}));
  clipboard.copyText.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("매크로 화면의 요청", () => {
  it("회원: 열 때 여덟 경로를 한 번씩 읽고, 실시간 시세는 1분 간격 SSE 하나 — 경제 캘린더·원본 데이터는 읽지 않는다", async () => {
    render(<SessionUserProvider user={MEMBER}><MacroPage /></SessionUserProvider>);

    expect(await settled()).toEqual(once(MEMBER_PATHS));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toBe(`http://backend${endpoints.live.stream(["TV:TVC:DXY"], 60)}`);
    expect(api.apiGet).not.toHaveBeenCalled();
  });

  it("운영자: 회원 경로에 경제 캘린더 하나를 더 읽는다", async () => {
    render(<SessionUserProvider user={OWNER}><MacroPage /></SessionUserProvider>);

    expect(await settled()).toEqual(once([...MEMBER_PATHS, endpoints.macro.econCalendar]));
  });

  it("'원본 데이터 보기'를 누르면 원본 글을 한 번 더 읽고, 다른 경로는 다시 읽지 않는다", async () => {
    render(<SessionUserProvider user={MEMBER}><MacroPage /></SessionUserProvider>);
    const before = await settled();

    fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기" }));
    expect(await screen.findByText("원본 글")).toBeTruthy();

    expect(await settled()).toEqual({ ...before, [endpoints.snapshot.text]: 1 });
  });

  it("'원본 데이터 복사'는 원본 글을 한 번 읽어(공유 읽기 아님) 복사한다", async () => {
    render(<SessionUserProvider user={MEMBER}><MacroPage /></SessionUserProvider>);
    const before = await settled();

    fireEvent.click(screen.getByRole("button", { name: "원본 데이터 복사" }));
    await waitFor(() => expect(clipboard.copyText).toHaveBeenCalledWith("원본 글"));

    expect(api.apiGet.mock.calls.map(([path]) => path)).toEqual([endpoints.snapshot.text]);
    expect(await settled()).toEqual(before);
  });

  it("간격을 5분으로 고르면 개요를 live 없이 한 번 읽고 SSE를 5분 간격으로 다시 연다 — 다른 경로는 다시 읽지 않는다", async () => {
    render(<SessionUserProvider user={MEMBER}><MacroPage /></SessionUserProvider>);
    const before = await settled();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    fireEvent.change(screen.getByLabelText("자동 갱신 간격"), { target: { value: "300" } });

    expect(await settled()).toEqual({ ...before, [endpoints.macro.overview(false)]: 1 });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1].url).toBe(`http://backend${endpoints.live.stream(["TV:TVC:DXY"], 300)}`);
  });

  it.each([
    ["좁은 화면(대화상자)", false],
    ["넓은 화면(옆 검사 칸)", true],
  ])("%s: 지표를 골라 미리보기를 열어도 요청이 늘지 않는다", async (_name, wide) => {
    if (wide) {
      vi.stubGlobal(
        "matchMedia",
        (query: string) =>
          ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
      );
    }
    render(<SessionUserProvider user={MEMBER}><MacroPage /></SessionUserProvider>);
    const before = await settled();

    fireEvent.click(await screen.findByRole("button", { name: "달러 인덱스" }));
    if (wide) {
      expect(screen.getByRole("region", { name: "지표 미리보기 — 달러 인덱스" })).toBeTruthy();
    } else {
      expect(await screen.findByRole("dialog", { name: "달러 인덱스" })).toBeTruthy();
    }

    expect(await settled()).toEqual(before);
    expect(api.apiGet).not.toHaveBeenCalled();
  });
});
