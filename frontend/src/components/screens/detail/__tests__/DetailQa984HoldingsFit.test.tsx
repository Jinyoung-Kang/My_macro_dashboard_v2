/**
 * 기관 상세 '보유 종목' 표의 넘침(QA-984). 응답은 모두 합성 값입니다.
 *
 * 2026-11-23 단계 1 배포 뒤 1440 폭에서 가운데 칸(584px)보다 표가 56px 넓어(표 최소 640px — 공용 표의 넘김 안내가 붙는 꼴) 오른쪽 '직전 분기 대비' 칸이
 * 잘려 넘겨야 보였습니다. 13F 화면은 같은 패널이 검사 칸 옆(좁은 표)일 때 칸 여백을 8px로 줄이고 최소 폭 없이 칸 폭에 맞추는데(약 574px까지 들어감),
 * 기관 상세는 검사 칸이 대화상자라 그 배치를 쓰지 않았습니다. 패널 폭을 재서 그 좁은 배치가 들어가는 폭(560px 이상)이면 같은 배치를 씁니다.
 * jsdom은 배치를 재지 않으므로 ResizeObserver로 상자 폭을 흉내 내고 클래스로 대조합니다. 실제 폭은 QA 스택 브라우저로 봅니다.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: () => null, WeightHeatmap: () => null, MultiLineSeries: () => null }));

import { InstitutionDetailScreen } from "../InstitutionDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const CIK = "0009999984";

/** 모든 관찰 대상의 폭을 `width`로 알리는 ResizeObserver(배치를 재지 않는 jsdom용). */
function stubBoxWidth(width: number) {
  class FakeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: { width, height: 400 } as DOMRectReadOnly } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeObserver);
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.institution.portfolio(CIK, 8, 30)
      ? Promise.resolve({
          available: true, cik: CIK, institution: { name: "합성 연금 (Synthetic Pension)", desc: "" },
          quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 2e9, holdingCount: 1 }],
          latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 2e9 },
          holdings: [{ name: "SYNTHETIC FIT CO", cusip: "000000984", class: "COM", value: 2e9, shares: 10, weight: 100, weightDiff: 1, sharesDiff: 0, action: "비중 확대 (Added)" }],
        })
      : new Promise(() => {}),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function holdingsTable() {
  render(
    <SessionUserProvider user={MEMBER}>
      <InstitutionDetailScreen cik={CIK} />
    </SessionUserProvider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: "보유 종목" }));
  await screen.findByRole("button", { name: "SYNTHETIC FIT CO 13F 줄 자세히" });
  return screen.getByRole("table");
}

describe("기관 상세 보유 표 — 칸 폭에 맞춤 (QA-984)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 상자 폭과 상관없이 표가 최소 640px(넘김 안내 꼴)였습니다.
  it.fails("패널 폭 584px(1440의 가운데 칸)이면 최소 폭 없이 좁은 배치(칸 여백 8px)", async () => {
    stubBoxWidth(584);
    const table = await holdingsTable();
    await waitFor(() => expect(table.className).not.toContain("min-w-[640px]"));
    expect(table.parentElement?.closest("[class*='[&_td]:px-2']")).not.toBeNull();
  });

  it("패널 폭이 좁으면(390 화면 약 340px) 지금처럼 최소 640px와 넘김 안내", async () => {
    stubBoxWidth(340);
    const table = await holdingsTable();
    expect(table.className).toContain("min-w-[640px]");
  });
});
