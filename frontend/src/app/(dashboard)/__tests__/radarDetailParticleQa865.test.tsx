/**
 * 수급 레이더 검사 칸의 '읽는 중·받지 못함' 글의 조사 — QA-865(작업대 P7 검토에서 찾음).
 *
 * 검사 칸(RankingDetail)은 화면이 이미 읽은 응답 셋(수급 지속성·재무·공통 목록)이 아직 오지 않았거나 실패했으면 그 사실을 적는데, 글이
 * `${label}를 …`로 받침과 상관없이 '를'을 붙여 '수급 지속성를 불러오는 중입니다.'·'공통 목록를 받지 못했습니다.'처럼 틀린 글이 보였습니다
 * (받침 있는 낱말 둘 — 지속성·목록). radarInspector 시험은 이 글을 보지 않았습니다.
 *
 * 기대: 받침이 있으면 '을', 없으면 '를' — '수급 지속성을'·'재무를'·'공통 목록을'. 읽는 중·실패(오류)·응답 없음 세 꼴.
 * 수정 전(재현 커밋에서는 it.fails): 첫 사례 "Unable to find an element with the text: 수급 지속성을 불러오는 중입니다.", 둘째 사례 "… 수급 지속성을 받지
 * 못했습니다(아래 패널의 오류 참고)."(보이는 글은 '수급 지속성를 …').
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RadarRow } from "@/lib/types";
import type { ConsensusRead } from "../radar/ConsensusPanel";
import type { StockFlowsRead } from "../radar/FlowPanels";
import type { FundamentalsRead } from "../radar/FundamentalsPanel";
import { RankingDetail } from "../radar/RankingDetail";

afterEach(() => cleanup());

const ROW = { rank: 1, code: "000001", name: "합성전자", price: 71000, changePct: 1.2, netAmountEok: 10 } as RadarRow;

/** 읽기 상태 하나(응답 없음) — 읽는 중이면 loading, 실패면 error. */
function read<T>(state: { loading: boolean; error: string | null }): T {
  return { data: null, loading: state.loading, error: state.error, refreshError: null, reload: async () => {} } as unknown as T;
}

function renderWith(state: { loading: boolean; error: string | null }) {
  render(
    <RankingDetail
      row={ROW}
      tradeType="순매수"
      source={null}
      flows={read<StockFlowsRead>(state)}
      fundamentals={read<FundamentalsRead>(state)}
      consensus={read<ConsensusRead>(state)}
    />,
  );
}

describe("수급 레이더 검사 칸 — 받침에 맞는 조사(QA-865)", () => {
  it.fails("읽는 중: '수급 지속성을'·'재무를'·'공통 목록을 불러오는 중입니다.'", () => {
    renderWith({ loading: true, error: null });
    for (const text of ["수급 지속성을 불러오는 중입니다.", "재무를 불러오는 중입니다.", "공통 목록을 불러오는 중입니다."]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(document.body.textContent).not.toMatch(/지속성를|목록를/);
  });

  it.fails("실패: '…을/를 받지 못했습니다(아래 패널의 오류 참고).', 응답 없음: '…을/를 받지 못했습니다.'", () => {
    renderWith({ loading: false, error: "실패" });
    for (const text of ["수급 지속성을", "재무를", "공통 목록을"]) {
      expect(screen.getByText(`${text} 받지 못했습니다(아래 패널의 오류 참고).`)).toBeTruthy();
    }
    cleanup();
    renderWith({ loading: false, error: null });
    for (const text of ["수급 지속성을", "재무를", "공통 목록을"]) {
      expect(screen.getByText(`${text} 받지 못했습니다.`)).toBeTruthy();
    }
    expect(document.body.textContent).not.toMatch(/지속성를|목록를/);
  });
});
