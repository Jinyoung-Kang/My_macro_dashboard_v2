/**
 * QA-738 — 모의 표의 종목 글 단추(TickerQuickView — 누르면 화면 안 시세 창)가 좁은 화면(lg 미만) 누름 자리 44px 미만(진행 기록 넘긴 항목
 * touch-targets-lt-lg-missed-by-qa458의 '종목 글 단추'). 표·목록 줄의 이름 단추와 같은 공용 조각(ui/classes ROW_TRIGGER — 좁은 화면 높이·폭 44px,
 * 넓은 화면 24px, 중립 잉크·밑줄·포커스 링)이어야 합니다. 보유 표·장중 시세 표·결정 상세가 이 단추를 씁니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/screens/detail/StockQuickView", () => ({
  // 시세 창(대화상자)은 이 시험 밖 — 여는 단추(trigger)만 그대로 그립니다.
  StockQuickView: ({ trigger }: { trigger: React.ReactElement }) => trigger,
}));

import { ROW_TRIGGER } from "@/components/ui";
import { TickerQuickView } from "../TickerQuickView";

afterEach(() => cleanup());

describe("QA-738 — 종목 글 단추의 누름 자리", () => {
  it("좁은 화면 높이·폭 44px, 넓은 화면 24px(공용 줄 단추 조각) — 한 글자 코드도", () => {
    render(<TickerQuickView market="US" code="F">F</TickerQuickView>);
    const button = screen.getByRole("button", { name: "F" });
    const classes = button.className.split(/\s+/);
    for (const token of ["min-h-11", "min-w-11", "lg:min-h-6", "lg:min-w-6"]) expect(classes, token).toContain(token);
    for (const token of ROW_TRIGGER.split(/\s+/)) expect(classes, token).toContain(token);
  });
});
