/**
 * 장중 판단 패널(자유 시점 판, ADR 0027) — '지금 장중 판단 요청'의 확인 단계. 확인을 누르면 Claude 호출이 한 번 예약되고 되돌릴 수 없으므로,
 * 확인 상자는 그것을 연 계좌에만 묶여 있어야 합니다(QA-366). 표본은 모두 합성 응답이고 요청은 목입니다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock("@/lib/api", () => api);

import { IntradayPlansPanel } from "../IntradayPlansPanel";

const STATUS = {
  session: "2026-11-09",
  maxPerSession: 2,
  books: [
    { book: "claude", freeTiming: true, plans: [] },
    { book: "claude2", freeTiming: true, plans: [] },
  ],
};

describe("장중 판단 패널의 확인 단계(QA-366)", () => {
  beforeEach(() => {
    api.apiPost.mockReset();
    api.apiPost.mockResolvedValue({ ok: true, planned: { slot: 1, atEt: "10:13", created: true } });
  });
  afterEach(cleanup);

  // 수정 전에는 확인 상자가 계좌와 무관한 불(confirming)이라, 연 채로 계좌를 바꾸면 그대로 남아 '요청 확인'이 바꾼 계좌로 요청을 보냈습니다
  // (재현 커밋에서는 it.fails).
  it.fails("확인 상자를 연 채 계좌를 바꾸면 상자가 닫혀 있고 요청이 나가지 않음", () => {
    const { rerender } = render(<IntradayPlansPanel intraday={STATUS} book="claude" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "지금 장중 판단 요청" }));
    expect(screen.queryByRole("button", { name: "요청 확인" })).not.toBeNull();

    rerender(<IntradayPlansPanel intraday={STATUS} book="claude2" onChanged={() => {}} />);

    expect(screen.queryByRole("button", { name: "요청 확인" })).toBeNull();
    expect(api.apiPost).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "지금 장중 판단 요청" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("확인을 누르면 그 계좌로 한 번 요청하고 결과를 적음", async () => {
    render(<IntradayPlansPanel intraday={STATUS} book="claude" onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "지금 장중 판단 요청" }));
    fireEvent.click(screen.getByRole("button", { name: "요청 확인" }));

    expect(await screen.findByText(/1번째 장중 판단을 10:13 ET로 예약했습니다/)).not.toBeNull();
    expect(api.apiPost).toHaveBeenCalledTimes(1);
    expect(api.apiPost.mock.calls[0][1]).toEqual({ book: "claude" });
  });
});
