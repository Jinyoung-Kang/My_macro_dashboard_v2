/**
 * 기관 선정 탭(미국)의 후보 거르기(작업대 P6 — 실행 명세 §7-1 '기관 선정·종목 선정: 조밀 표와 필터', 사용자 결정 거리 U9 권장안). 받은 후보 줄 안에서만
 * 거릅니다(서버 거르기 없음 — 새 요청 없음). 순수 함수(ADR 0004).
 */
import type { PaperTrackRecordCandidate } from "./types";

/** 후보 거르기 칸 — 전체 · 자격 있음 · 선정. */
export type CandidateFilter = "all" | "eligible" | "selected";

/** 거르기 칸 하나 — 키·이름·그 칸에 드는 후보 수(받은 줄 안). */
export interface CandidateFilterOption {
  key: CandidateFilter;
  label: string;
  count: number;
}

/** 후보 거르기 칸 — 이름 뒤 수는 받은 줄 기준. 줄이 없는 칸도 그립니다(0 — 고를 수 있는 칸이 바뀌지 않게). */
export function candidateFilterOptions(rows: readonly Pick<PaperTrackRecordCandidate, "eligible" | "selected">[]): CandidateFilterOption[] {
  return [
    { key: "all", label: "전체", count: rows.length },
    { key: "eligible", label: "자격 있음", count: rows.filter((row) => row.eligible === true).length },
    { key: "selected", label: "선정", count: rows.filter((row) => row.selected === true).length },
  ];
}

/** 고른 칸의 후보만(서버 차례 — 순위 차례 그대로). */
export function filterCandidates<T extends Pick<PaperTrackRecordCandidate, "eligible" | "selected">>(rows: readonly T[], filter: CandidateFilter): T[] {
  if (filter === "eligible") return rows.filter((row) => row.eligible === true);
  if (filter === "selected") return rows.filter((row) => row.selected === true);
  return [...rows];
}
