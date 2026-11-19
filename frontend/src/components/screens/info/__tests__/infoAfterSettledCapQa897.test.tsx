/**
 * 정보 수집 국내·뉴스 탭 — 위 패널이 답하지 않을 때 아래 패널의 상한 — QA-897(D6 전 QA 반박 확인에서 찾음 — QA-893 `e06b1328`·QA-894 `3242c698`의 AfterSettled).
 *
 * AfterSettled는 위 패널(국내 탭 KRX, 뉴스 탭 catalog + 글 목록)이 처음 답할 때까지 아래 패널(국내 탭 네이버·출처, 뉴스 탭 출처)을 그리되 hidden으로
 * 둡니다. 그런데 hooks/useApi에는 시간 제한이 없어(apiGetShared timeoutMs 0) 위 응답이 오지 않고 연결도 끊기지 않으면 이미 받은 아래 패널이 끝없이
 * 숨었습니다(머리 없는 크롬 — KRX 응답 보류 동안 계속 hidden, QA 스택은 같은 조건에서 네이버를 보임).
 *
 * 기대: 위 패널이 2초 안에 답하지 않으면 아래 패널을 그냥 보입니다(그 뒤 위가 답하면 예전처럼 밀릴 수 있음 — 보통 경우는 위가 2초 안에 답해 QA-893·894의
 * 이득을 지킴: QA 스택 위 응답 KRX 약 0.01초·catalog 약 0.3초, catalog 16개 동시 최대 0.65초). 2초 안에 답하면 답한 때 보이는 것은 그대로입니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 국내 탭 'expected <div hidden class="space-y-6">…(2)</div> to be null'·뉴스 탭 '…(1)</div> to be null'
 * (2초가 지나도 hidden). 셋째 사례(2초 안에 답함)는 고치기 전에도 통과 — 이득을 지키는지 보는 지킴입니다.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import InfoHub from "../InfoHub";

const CATALOG = { checkedAt: "2026-11-19 10:00 KST", collectorReachable: true, tabs: [], sources: [], incidents: [] };
const FLOWS = { available: false, collectedAtKst: null, failed: [] };
const LIST = { available: true, items: [], page: 1, size: 10, total: 0, pages: 0 };

/** 주어진 경로 앞부분은 곧 답하고, 나머지(위 패널의 읽기 포함)는 끝나지 않습니다. */
function answer(routes: Record<string, unknown>) {
  api.apiGetShared.mockImplementation((path: string) => {
    const hit = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    return hit ? Promise.resolve(routes[hit]) : new Promise(() => {});
  });
}
/** 제목(h2)이 든 패널이 hidden 안에 있는가. */
const hiddenPanel = (title: string) => screen.getByText(title, { selector: "h2" }).closest("[hidden]");

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  api.apiGetShared.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("정보 수집 위 패널이 답하지 않을 때 아래 패널(QA-897)", () => {
  it("국내 탭: KRX가 답하지 않아도 2초 뒤에는 네이버·출처 패널이 보인다(그 전에는 hidden)", async () => {
    answer({ "/api/info/flows": FLOWS, "/api/info/catalog": CATALOG });
    render(<InfoHub tab="kr" />);
    await advance(1_999);
    expect(hiddenPanel("네이버 투자자별 매매동향·매매상위")).toBeTruthy();
    expect(hiddenPanel("출처")).toBeTruthy();
    await advance(1);
    expect(hiddenPanel("네이버 투자자별 매매동향·매매상위")).toBeNull();
    expect(hiddenPanel("출처")).toBeNull();
  });

  it("뉴스 탭: catalog가 답하지 않아도 2초 뒤에는 출처 패널이 보인다(그 전에는 hidden)", async () => {
    answer({ "/api/info/items?kind=blog": LIST });
    render(<InfoHub tab="news" />);
    await advance(1_999);
    expect(hiddenPanel("출처")).toBeTruthy();
    await advance(1);
    expect(hiddenPanel("출처")).toBeNull();
  });

  it("2초 안에 답하면(오류여도) 답한 때 보인다 — 상한 전에도 그대로(QA-893)", async () => {
    let fail: (error: Error) => void = () => {};
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/info/krx")) return new Promise((_, reject) => { fail = reject; });
      if (path.startsWith("/api/info/flows")) return Promise.resolve(FLOWS);
      if (path.startsWith("/api/info/catalog")) return Promise.resolve(CATALOG);
      return new Promise(() => {});
    });
    render(<InfoHub tab="kr" />);
    await advance(500);
    expect(hiddenPanel("출처")).toBeTruthy();
    await act(async () => fail(new Error("합성 실패")));
    await advance(1);
    expect(hiddenPanel("출처")).toBeNull();
  });
});
