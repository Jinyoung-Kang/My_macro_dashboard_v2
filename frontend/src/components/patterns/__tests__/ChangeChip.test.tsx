/**
 * ChangeChip — 변화 칩(설계서 §5 "변화 없음은 칩 생략(0.00% 아님)").
 * 네 상태: 값 있음(▲/▼ + 부호 + %), 값 없음(둘 다 null이면 칩 없음), 0으로 찍힘(중립·화살표 없음),
 * 추정·오래됨은 칩이 아니라 옆 배지가 말한다 — 칩은 같은 모양을 유지한다.
 * 부호 기호는 −(U+2212)·+, 방향은 화살표(읽어 주기에서 뺌)와 말("상승"/"하락"/"변화 없음")로.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChangeChip } from "../ChangeChip";
import { EstimateBadge, StaleBadge } from "../badges";

afterEach(() => cleanup());

const MINUS = "−";

describe("ChangeChip", () => {
  it("값 있음(상승) — ▲, +, %, 상승색, 읽어 주는 '상승'", () => {
    const { container } = render(<ChangeChip change={12.346} changePct={0.456} unit="원" />);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.className).toContain("text-up");
    expect(chip.className).toContain("tabular-nums");
    expect(screen.getByText("▲").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("상승").className).toContain("sr-only");
    expect(screen.getByText("원").className).toContain("text-[0.85em]");
    expect(screen.getByText("(+0.46%)")).toBeTruthy();
    expect(chip.textContent).toBe("▲상승+12.35원(+0.46%)");
  });

  it("값 있음(하락) — ▼, −(U+2212), 하락색", () => {
    const { container } = render(<ChangeChip changePct={-1.234} />);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.className).toContain("text-down");
    expect(screen.getByText("▼")).toBeTruthy();
    expect(screen.getByText("하락")).toBeTruthy();
    expect(screen.getByText(`${MINUS}1.23%`)).toBeTruthy();
    expect(chip.textContent).not.toContain("-");
  });

  it("값 없음 — 둘 다 null이면 칩을 그리지 않는다(0.00%를 만들지 않음)", () => {
    const { container } = render(<ChangeChip change={null} changePct={null} />);
    expect(container.innerHTML).toBe("");
    cleanup();
    const second = render(<ChangeChip />);
    expect(second.container.innerHTML).toBe("");
    cleanup();
    const third = render(<ChangeChip change={NaN} changePct={Infinity} />);
    expect(third.container.innerHTML).toBe("");
  });

  it("보이는 값이 0이면 중립 — 화살표·부호 없음, '변화 없음'", () => {
    const { container } = render(<ChangeChip change={-0.004} changePct={0.001} />);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.className).toContain("text-neutral");
    expect(chip.className).not.toContain("text-up");
    expect(chip.className).not.toContain("text-down");
    expect(screen.queryByText("▲")).toBeNull();
    expect(screen.queryByText("▼")).toBeNull();
    expect(screen.getByText("변화 없음")).toBeTruthy();
    expect(chip.textContent).toBe("변화 없음0.00(0.00%)");
  });

  it("digits는 변화량·변화율에 함께, 기본 2", () => {
    render(<ChangeChip change={1500} changePct={1.2345} digits={0} />);
    expect(screen.getByText("+1,500")).toBeTruthy();
    expect(screen.getByText("(+1%)")).toBeTruthy();
  });

  it("pctDigits — 변화율만 따로(변화량 셋째, 변화율 둘째)", () => {
    render(<ChangeChip change={-0.007} changePct={-0.1402} digits={3} pctDigits={2} />);
    expect(screen.getByText(`${MINUS}0.007`)).toBeTruthy();
    expect(screen.getByText(`(${MINUS}0.14%)`)).toBeTruthy();
    expect(screen.getByText("하락")).toBeTruthy();
  });

  it("size — sm은 text-xs, 기본(md)은 text-sm", () => {
    const { container } = render(
      <>
        <ChangeChip changePct={1} size="sm" />
        <ChangeChip changePct={1} />
      </>,
    );
    const [small, medium] = Array.from(container.children) as HTMLElement[];
    expect(small.className).toContain("text-xs");
    expect(medium.className).toContain("text-sm");
  });

  it("상승·하락 글자에 바탕색을 칠하지 않는다(surface·bg 위에서만 대비 4.5:1)", () => {
    const { container } = render(<ChangeChip changePct={2} />);
    expect((container.firstElementChild as HTMLElement).className).not.toMatch(/\bbg-/);
  });

  // 칩은 추정·오래됨 플래그를 받지 않는다 — 그 표시는 칩을 쓰는 쪽(AssetRow·StatTile)이 옆 배지로 그리고, 그쪽 네 상태 테스트가 본다.
  // 여기서는 배지가 옆에 있어도 칩이 숨거나 모양·색이 바뀌지 않는지만 본다.
  it("추정·오래됨 — 플래그를 받지 않는 칩이라 옆 배지가 있어도 칩은 혼자일 때와 똑같다", () => {
    const { container: alone } = render(<ChangeChip changePct={0.5} />);
    const aloneHtml = (alone.firstElementChild as HTMLElement).outerHTML;
    cleanup();

    const { container } = render(
      <span>
        <ChangeChip changePct={0.5} />
        <EstimateBadge estimated />
        <StaleBadge stale reason="수집 실패" />
      </span>,
    );
    const row = container.firstElementChild as HTMLElement;
    expect((row.firstElementChild as HTMLElement).outerHTML).toBe(aloneHtml);
    expect(screen.getByText("+0.50%")).toBeTruthy();
    expect(screen.getByText("추정")).toBeTruthy();
    expect(screen.getByText("이전 값")).toBeTruthy();
  });
});
