/**
 * 상태 배지 — ProvenanceBadge·EstimateBadge·StaleBadge(설계서 §5 "플래그가 있으면 반드시 보인다").
 * 네 상태: 값 있음(출처·지연·시각), 값 없음(모르는 부분 생략·"출처 —"·플래그 없으면 배지 없음),
 * 추정·대리(라벨 글자), 오래됨(⚠️ 이전 값 + 사유). 색만으로 뜻을 전하지 않는다(라벨 글자가 늘 있음).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EstimateBadge, ProvenanceBadge, StaleBadge } from "../badges";

afterEach(() => cleanup());

describe("ProvenanceBadge", () => {
  it("값 있음 — 출처 · 지연 · 시각을 한 알약에", () => {
    render(<ProvenanceBadge source="FRED" delayMin={15} asOf="2026-10-26 14:20" />);
    const badge = screen.getByText("FRED · 15분 지연 · 2026-10-26 14:20");
    expect(badge.className).toContain("rounded-full");
    expect(badge.className).toContain("border");
    expect(badge.className).toContain("tabular-nums");
  });

  it("실시간 — live면 지연 분과 상관없이 '실시간'", () => {
    render(<ProvenanceBadge source="TradingView" live delayMin={15} />);
    expect(screen.getByText("TradingView · 실시간")).toBeTruthy();
  });

  it("ISO 시각은 KST 한 형식으로", () => {
    render(<ProvenanceBadge source="KRX" asOf="2026-10-26T06:30:00Z" />);
    expect(screen.getByText("KRX · 2026-10-26 15:30")).toBeTruthy();
  });

  it("값 없음 — 모르는 부분은 빼고, 전부 모르면 '출처 —'", () => {
    render(<ProvenanceBadge source={null} delayMin={10} asOf={null} />);
    expect(screen.getByText("10분 지연")).toBeTruthy();
    cleanup();
    render(<ProvenanceBadge />);
    expect(screen.getByText("출처 —")).toBeTruthy();
  });
});

describe("EstimateBadge", () => {
  it("값 있음(플래그 없음)이면 그리지 않는다", () => {
    const { container } = render(<EstimateBadge estimated={false} proxy={false} note="무시" />);
    expect(container.innerHTML).toBe("");
  });

  it("추정 — '추정' 라벨과 설명", () => {
    render(<EstimateBadge estimated note="KODEX 200 기반 추정치" />);
    expect(screen.getByText("추정")).toBeTruthy();
    expect(screen.getByText("· KODEX 200 기반 추정치")).toBeTruthy();
  });

  it("대리 지표 — '대리 지표' 라벨, 점선 테두리는 보조 표시", () => {
    render(<EstimateBadge proxy note="실제 ICE BofA MOVE 아님" />);
    const label = screen.getByText("대리 지표");
    expect(label.parentElement?.className).toContain("border-dashed");
    expect(screen.getByText("· 실제 ICE BofA MOVE 아님")).toBeTruthy();
  });

  it("둘 다면 두 라벨을 함께, 설명이 비었거나 N/A면 붙이지 않는다", () => {
    const { container } = render(<EstimateBadge estimated proxy note="N/A" />);
    expect(screen.getByText("추정 · 대리 지표")).toBeTruthy();
    expect(container.textContent).toBe("추정 · 대리 지표");
  });
});

describe("StaleBadge", () => {
  it("값 있음(신선)이면 그리지 않는다 — 사유만 와도", () => {
    const { container } = render(<StaleBadge stale={false} reason="수집 실패" />);
    expect(container.innerHTML).toBe("");
  });

  it("오래됨 — ⚠️ 아이콘 + '이전 값' 글 + 사유, 경고색", () => {
    render(<StaleBadge stale reason="이번 수집 실패 — 직전 저장본" />);
    const label = screen.getByText("이전 값");
    const pill = label.parentElement as HTMLElement;
    expect(pill.className).toContain("text-warn");
    expect(pill.className).toContain("border-warn");
    expect(pill.className).toContain("rounded-full");
    expect(screen.getByText("⚠️").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("주의:").className).toContain("sr-only");
    expect(screen.getByText("· 이번 수집 실패 — 직전 저장본")).toBeTruthy();
  });

  it("사유를 모르면 라벨만 — 사유를 지어내지 않는다", () => {
    const { container } = render(<StaleBadge stale reason={null} />);
    expect(container.textContent).toBe("⚠️주의: 이전 값");
  });

  it("배지에 바탕색을 칠하지 않는다(경고색 글자 대비 유지)", () => {
    render(
      <>
        <StaleBadge stale />
        <EstimateBadge estimated />
        <ProvenanceBadge source="FRED" />
      </>,
    );
    for (const text of ["이전 값", "추정"]) {
      expect((screen.getByText(text).parentElement as HTMLElement).className).not.toMatch(/\bbg-/);
    }
    expect(screen.getByText("FRED").className).not.toMatch(/\bbg-/);
  });
});
