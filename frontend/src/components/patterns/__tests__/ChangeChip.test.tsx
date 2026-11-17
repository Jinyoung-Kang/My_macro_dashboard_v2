/**
 * ChangeChip — 변화 칩(설계서 §5 "변화 없음은 칩 생략(0.00% 아님)").
 * 네 상태: 값 있음(▲/▼ + 부호 + %), 값 없음(둘 다 null이면 칩 없음), 0으로 찍힘(중립·화살표 없음),
 * 추정·오래됨은 칩이 아니라 옆 배지가 말한다 — 칩은 같은 모양을 유지한다.
 * 부호 기호는 −(U+2212)·+, 방향은 화살표(읽어 주기에서 뺌)와 말("상승"/"하락"/"변화 없음")로.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChangeCell, ChangeChip } from "../ChangeChip";
import { DataTable } from "../DataTable";
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
    expect(screen.getByText("원").className).toContain("text-xs");
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

  it("size — sm(자산 행·표)은 caption 13px, 기본 md(히어로·KPI)는 body 14px 굵게(글자 단계, 작업대 실행 명세 §3-6)", () => {
    const { container } = render(
      <>
        <ChangeChip changePct={1} size="sm" />
        <ChangeChip changePct={1} />
      </>,
    );
    const [small, medium] = Array.from(container.children) as HTMLElement[];
    expect(small.className.split(/\s+/)).toContain("text-caption");
    expect(medium.className.split(/\s+/)).toContain("text-body");
    expect(medium.className).toContain("font-semibold");
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

// QA-595: 칩이 inline-flex flex-wrap이라 표 자동 배치가 칸에 최소 내용 폭(숫자 하나)만 주면, 홈 계좌 손익 표의 '▼'가 숫자와 다른 줄에 홀로 남고
// 시장 표의 변화량과 변화율이 두 줄로 갈렸습니다(390~1920 모든 폭). 칸의 whitespace-nowrap은 flex 항목 사이의 줄바꿈을 막지 못합니다.
// 수정 전(재현 커밋에서는 it.fails) 칩 바깥 상자는 'inline-flex flex-wrap items-baseline gap-x-1 tabular-nums …'이고 화살표의 부모가 그 상자였습니다.
describe("ChangeChip — 줄바꿈 (QA-595)", () => {
  it("nowrap — 표 칸 안의 칩은 flex-nowrap(변화량과 변화율도 한 줄), 주지 않으면 flex-wrap 그대로", () => {
    const { container } = render(
      <>
        <ChangeChip changePct={-0.48} size="sm" nowrap />
        <ChangeChip changePct={-0.48} size="sm" />
      </>,
    );
    const [inCell, plain] = Array.from(container.children) as HTMLElement[];
    expect(inCell.className.split(/\s+/)).toContain("flex-nowrap");
    expect(inCell.className.split(/\s+/)).not.toContain("flex-wrap");
    expect(plain.className.split(/\s+/)).toContain("flex-wrap");
  });

  it("화살표는 첫 값과 줄 바꿈 없는 묶음 — 변화량이 있으면 변화량, 없으면 변화율과 함께(화살표만 윗줄에 홀로 남지 않음)", () => {
    render(<ChangeChip change={-0.42} changePct={-0.42} size="sm" />);
    const group = screen.getByText("▼").parentElement as HTMLElement;
    expect(group.className.split(/\s+/)).toContain("whitespace-nowrap");
    expect(within(group).getByText(`${MINUS}0.42`)).toBeTruthy();
    expect(within(group).getByText("하락").className).toContain("sr-only");
    // 줄바꿈은 변화량과 변화율 사이에서만 — 변화율은 묶음 밖입니다.
    expect(within(group).queryByText(`(${MINUS}0.42%)`)).toBeNull();
    cleanup();

    render(<ChangeChip changePct={-0.48} size="sm" />);
    const alone = screen.getByText("▼").parentElement as HTMLElement;
    expect(alone.className.split(/\s+/)).toContain("whitespace-nowrap");
    expect(within(alone).getByText(`${MINUS}0.48%`)).toBeTruthy();
  });
});

describe("ChangeCell — 표 칸의 변화", () => {
  it("값 있음 — 작은 칩(sm·칸 안에서 꺾지 않음): 화살표·부호 −·읽는 방향 글, 단위·자릿수는 칩 그대로", () => {
    const { container } = render(
      <>
        <ChangeCell changePct={-12.15} />
        <ChangeCell change={3.2} unit="%p" />
        <ChangeCell change={-1250} digits={0} />
      </>,
    );
    const chips = Array.from(container.children) as HTMLElement[];
    expect(chips.map((chip) => chip.textContent)).toEqual(["▼하락−12.15%", "▲상승+3.20%p", "▼하락−1,250"]);
    for (const chip of chips) {
      expect(chip.className).toContain("flex-nowrap");
      expect(chip.className).toContain("text-caption");
    }
    expect(chips[0].className).toContain("text-down");
    expect(chips[1].className).toContain("text-up");
  });

  it("빈 값 — 변화량·변화율을 둘 다 모르면(null·undefined·NaN) 공용 표의 모르는 칸과 같은 '—'(읽기는 '값 없음', 보조 글자색) — 0.00%를 만들지 않음", () => {
    const { container } = render(
      <>
        <ChangeCell changePct={null} />
        <ChangeCell change={Number.NaN} changePct={undefined} />
      </>,
    );
    const cells = Array.from(container.children) as HTMLElement[];
    for (const cell of cells) {
      expect(cell.className).toBe("text-text-3");
      expect(cell.textContent).toBe("—값 없음");
      expect(within(cell).getByText("값 없음").className).toContain("sr-only");
    }
    expect(container.textContent).not.toMatch(/0\.00/);
  });

  it("공용 표 안 — 모르는 칸은 칸이 null을 돌려줄 때(표가 그리는 '—')와 같은 모양, 아는 칸은 칩(읽는 중·오류는 표·패널이 그림)", () => {
    type Row = { key: string; pct: number | null };
    render(
      <DataTable<Row>
        caption="변화 표"
        rows={[{ key: "a", pct: 1.5 }, { key: "b", pct: null }]}
        rowKey={(row) => row.key}
        columns={[
          { key: "name", header: "이름", cell: (row) => row.key },
          { key: "cell", header: "칸", align: "right", cell: (row) => <ChangeCell changePct={row.pct} /> },
          { key: "plain", header: "표 기본", align: "right", cell: () => null },
        ]}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    const [, known] = within(rows[0]).getAllByRole("cell");
    expect(known.textContent).toBe("▲상승+1.50%");
    const [, unknown, plain] = within(rows[1]).getAllByRole("cell");
    expect(unknown.innerHTML).toBe(plain.innerHTML);
  });
});
