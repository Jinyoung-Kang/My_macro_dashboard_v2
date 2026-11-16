/**
 * QA-568: 공용 글 부품이 좁은 칸에서 한글 낱말 가운데서 줄을 바꿨습니다 — 브라우저 기본 줄바꿈(word-break: normal)은 한글 음절 사이를 모두 끊을 수 있는
 * 자리로 봅니다. P4의 좁은 칸(13rem 왼쪽 칸·18rem 오른쪽 칸·xl 가운데 칸·KPI 타일)에서 주 폭(1280~1920)에도 늘 보였습니다: 출처 배지 '참고 시|세 · 개장',
 * 이전 값 배지 '관측치 저장본이 늦|음', 패널 부제 '아니|며', 출처 줄 '기|업 개요', 속성 빈 글 '받지 못했습니|다.', 상태 글 '요청|을 멈춤'.
 *
 * 고친 뒤: 그 부품들의 글이 낱말 사이에서만 줄을 바꿉니다(break-keep — word-break: keep-all, QA-526·QA-449와 같은 규약). 배지·출처 줄은 공백 없는 긴 영문·날짜
 * 토큰만 칸 안에서 꺾습니다(wrap-break-word — overflow-wrap: break-word). wrap-anywhere가 아닌 까닭은 이 배지들이 자동 배치 표 칸에도 들어가기 때문입니다 —
 * anywhere는 칸의 최소 내용 폭을 한 글자로 줄여 라틴 낱말이 글자마다 꺾입니다(QA-526이 wrap-anywhere를 뺀 것과 같은 까닭).
 * jsdom은 배치를 재지 못하므로 클래스를 대조하고, 실제 줄바꿈은 브라우저 하네스로 잽니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Panel, SourceLine } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";

import { EstimateBadge, ProvenanceBadge, StaleBadge } from "../badges";
import { PropertyList } from "../PropertyList";

afterEach(() => cleanup());

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** 글 요소에서 stop(포함)까지 올라가며 cls가 있는지 — word-break·overflow-wrap은 상속되므로 배지·문단 조상 어디에 있어도 됩니다. */
function chainHas(element: Element, stop: Element, cls: string): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (tokens(node).includes(cls)) return true;
    if (node === stop) break;
  }
  return false;
}

/** 자리 이름 → [한글 글 요소, 배지·문단(사슬의 끝)]. */
function places(): Record<string, [Element, Element]> {
  const found: Record<string, [Element, Element]> = {};
  const add = (name: string, text: Element, stop: Element | null) => {
    if (!stop) throw new Error(`${name}: 사슬의 끝을 찾지 못했습니다`);
    found[name] = [text, stop];
  };

  const provenance = screen.getByText(/참고 시세 · 개장/);
  add("ProvenanceBadge", provenance, provenance.closest("span.text-xs"));

  const stale = screen.getByText(/관측치 저장본이 늦음/);
  add("StaleBadge 사유", stale, stale.closest("span.rounded-control"));

  const estimate = screen.getByText(/대리 지표 산식/);
  add("EstimateBadge 설명", estimate, estimate.closest("span.rounded-control"));

  const subtitle = screen.getByText(/투자 권유가 아니며/);
  add("Panel 부제", subtitle, subtitle.closest("p"));

  const panelSource = screen.getByText("네이버 증권 해외주식 기업 개요");
  add("Panel 출처 줄", panelSource, panelSource.closest("p"));

  const sourceLine = screen.getByText("한국거래소 정보데이터시스템");
  add("SourceLine", sourceLine, sourceLine.closest("p"));

  const empty = screen.getByText("핵심 지표를 받지 못했습니다.");
  add("PropertyList 빈 글", empty, empty.closest("p"));

  const listSource = screen.getByText("SEC EDGAR 13F 보고서 원문");
  add("PropertyList 출처 줄", listSource, listSource.closest("p"));

  const status = screen.getByText(/Yahoo 요청을 멈춤/);
  add("StatusText", status, status.closest("span.inline-flex"));
  return found;
}

function renderAll() {
  render(
    <div>
      <ProvenanceBadge source="TradingView (TVC:US10Y) · 참고 시세 · 개장" asOf="2026-11-14 15:30" delayMin={15} />
      <StaleBadge stale reason="관측치 저장본이 늦음 · 마지막 관측 2026-11-14" />
      <EstimateBadge proxy note="대리 지표 산식으로 계산한 값" />
      <Panel
        title="AI 요약"
        subtitle="이 화면의 시세·지표·뉴스만 근거로 Claude가 요약합니다. 투자 권유가 아니며, 숫자는 이 화면의 값과 출처에서 확인하세요."
        source="네이버 증권 해외주식 기업 개요"
      >
        <p>본문</p>
      </Panel>
      <SourceLine>한국거래소 정보데이터시스템</SourceLine>
      <PropertyList items={[]} emptyText="핵심 지표를 받지 못했습니다." source="SEC EDGAR 13F 보고서 원문" />
      <StatusText tone="warn">Yahoo 연결 실패 — 연달아 5번 실패해 118초 더 Yahoo 요청을 멈춤</StatusText>
    </div>,
  );
}

describe("QA-568 공용 글 부품 — 한글은 낱말 사이에서만 줄바꿈", () => {
  // 수정 전 실패: 아홉 자리 모두 break-keep이 없음(재현 커밋에서는 it.fails).
  it.fails("배지·패널 부제·출처 줄·속성 빈 글·상태 글의 한글 글에서 그 배지·문단까지 break-keep이 있다", () => {
    renderAll();
    const missing = Object.entries(places())
      .filter(([, [text, stop]]) => !chainHas(text, stop, "break-keep"))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  // 배지·출처 줄의 비상 꺾기는 wrap-break-word(자동 배치 표 칸의 최소 폭을 줄이지 않음) — wrap-anywhere·break-all은 두지 않습니다.
  it.fails("배지·출처 줄은 공백 없는 긴 토큰만 칸 안에서 꺾는다(wrap-break-word, wrap-anywhere·break-all 없음)", () => {
    renderAll();
    const all = places();
    const names = ["ProvenanceBadge", "StaleBadge 사유", "EstimateBadge 설명", "Panel 출처 줄", "SourceLine", "PropertyList 출처 줄"];
    const wrong = names.filter((name) => {
      const [text, stop] = all[name];
      return !chainHas(text, stop, "wrap-break-word") || chainHas(text, stop, "wrap-anywhere") || chainHas(text, stop, "break-all");
    });
    expect(wrong).toEqual([]);
  });
});
