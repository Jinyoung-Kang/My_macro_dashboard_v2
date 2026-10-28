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
    // 바깥 span이 sr-only(절대 위치)의 기준 상자 — 가로 스크롤 표 칸 밖으로 빠져 문서 폭을 넓히지 않게(390px 화면 확인, 2026-10-29).
    expect((container.firstElementChild as HTMLElement).className).toContain("relative");
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

  // Empty는 추정·오래됨 플래그를 받지 않는다 — 값이 없을 때 그 플래그를 함께 보이는 일은 쓰는 쪽(StatTile·AssetRow)의 네 상태 테스트 몫.
  // 여기서는 배지가 옆에 있어도 "—"와 사유가 그대로인지(배지를 가리거나 대신하지 않음)만 본다.
  it("추정·오래됨 — 플래그를 받지 않으므로 옆 배지가 있어도 '—'와 사유는 혼자일 때와 똑같다", () => {
    const { container: alone } = render(<Empty reason="이번 수집 실패" />);
    const aloneHtml = (alone.firstElementChild as HTMLElement).outerHTML;
    cleanup();

    const { container } = render(
      <span>
        <Empty reason="이번 수집 실패" />
        <EstimateBadge estimated />
        <StaleBadge stale reason="직전 저장본" />
      </span>,
    );
    const row = container.firstElementChild as HTMLElement;
    expect((row.firstElementChild as HTMLElement).outerHTML).toBe(aloneHtml);
    expect(screen.getByText("추정")).toBeTruthy();
    expect(screen.getByText("이전 값")).toBeTruthy();
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
