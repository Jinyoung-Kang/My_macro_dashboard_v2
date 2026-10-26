/**
 * Empty — 값이 없을 때의 "—"와 사유(설계서 §6 네 상태 중 '값 없음'의 기본 조각).
 *  - "—"는 보이되 읽어 주기에서 빼고 "값 없음"을 읽는다
 *  - 사유가 있으면 작은 글자로 보이고, 비었거나 수집기의 "N/A"면 그리지 않는다
 *  - 0을 찍지 않는다
 *  - 추정·오래됨: 값이 없어도 옆의 배지는 함께 보인다(플래그를 숨기지 않음)
 * 값 있음 상태는 Empty를 쓰는 쪽(StatTile·Hero·AssetRow·DataTable) 테스트가 확인한다 — 값이 있으면 Empty를 그리지 않는다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EstimateBadge, StaleBadge } from "../badges";
import { Empty } from "../Empty";

afterEach(() => cleanup());

describe("Empty", () => {
  it("사유 없이 — 와 읽어 주는 '값 없음'만", () => {
    const { container } = render(<Empty />);
    const dash = screen.getByText("—");
    expect(dash.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("값 없음").className).toContain("sr-only");
    expect(container.textContent).toBe("—값 없음");
    expect(container.textContent).not.toContain("0");
  });

  it("사유가 있으면 작은 보조 글자로 보인다", () => {
    render(<Empty reason="표본 부족(20일 미만)" />);
    const reason = screen.getByText("표본 부족(20일 미만)");
    expect(reason.className).toContain("text-xs");
    expect(reason.className).toContain("text-text-3");
    expect(reason.className).not.toContain("sr-only");
  });

  it("빈 사유·공백 사유·null·수집기의 'N/A'는 그리지 않는다", () => {
    for (const reason of [null, "", "   ", "N/A", "—"]) {
      const { container } = render(<Empty reason={reason} />);
      expect(container.textContent).toBe("—값 없음");
      cleanup();
    }
  });

  it("추정·오래됨 — '—' 옆에 배지가 함께 보인다(값이 없어도 플래그를 숨기지 않음)", () => {
    render(
      <span>
        <Empty reason="이번 수집 실패" />
        <EstimateBadge estimated />
        <StaleBadge stale reason="직전 저장본" />
      </span>,
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("이번 수집 실패")).toBeTruthy();
    expect(screen.getByText("추정")).toBeTruthy();
    expect(screen.getByText("이전 값")).toBeTruthy();
    expect(screen.getByText("· 직전 저장본")).toBeTruthy();
  });

  it("문장 안에 놓일 수 있게 인라인 요소다", () => {
    const { container } = render(
      <p>
        전일 대비 <Empty reason="전일 종가 미제공" />
      </p>,
    );
    expect(container.querySelector("p > span")).not.toBeNull();
    expect(container.querySelector("div")).toBeNull();
  });
});
