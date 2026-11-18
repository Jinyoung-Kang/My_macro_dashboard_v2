/**
 * 표 히트맵의 순차 팔레트와 단계 — React를 모르는 순수 모듈(그리기는 components/charts/HeatmapTable.tsx).
 *
 * 순차 팔레트(작업대 실행 명세 §3-5 — 순차는 강조·상승·하락과 다른 계열의 한 색 밝기 단계): 보라 단계 다섯, 어두운 단계(0에 가까움) → 밝은 단계(큼).
 * 어두운 바탕 위라 큰 값을 밝게 둡니다 — 바탕(surface)에서 멀어질수록 큰 값입니다. 공개 확장 색 패키지의 보라 다섯 단계를 원문에서 다시 받아 그대로 씁니다.
 * dataviz 검증기(저장소 밖)로 잰 값 [계산 — surface #1c2127, 기록은 명세 §3-5]:
 *  - 순서 단계: 밝기(OKLab L)가 단계마다 오름(0.366 → 0.772, 이웃 ΔL 0.081 이상), 색상각 폭 1°(한 색).
 *  - 가장 어두운 단계 대 패널 면 1.45:1 — 서수 하한 2:1에 못 미치지만 순차(크기) 규칙은 0에 가까운 단계가 면으로 물러나도 됨(칸마다 숫자가 적혀 있음).
 *  - 강조 파랑과 OKLab ΔE 최소 17.6, 상승 16.2, 하락 15.0, 주의 18.7, 정상 20.6, 위험 13.9(위험은 늘 아이콘 + 글이라 칸과 섞이지 않음).
 *  - 칸 글자: 단계 1~3은 본문색(--text — 10.45·7.52·5.39:1), 4~5는 바탕색(--bg — 5.28·8.61:1), 모두 WCAG 4.5:1 이상.
 * 값을 바꾸려면 검증기를 다시 돌려 명세 §3-5에 적고, 팔레트 기록 시험(lib/__tests__/paletteRecord.test.ts)의 기대 상수와 이 파일을 같은 커밋에서 고칩니다.
 */

/** 단계 1~5의 칸 바탕(hex, 소문자) — 차례대로 0에 가까움 → 큼. */
export const SEQUENTIAL_STEPS: readonly string[] = ["#5c255c", "#7c327c", "#9d3f9d", "#bd6bbd", "#d69fd6"];

/** 단계 1~5의 칸 글자색 — 그 단계 바탕 위 WCAG 4.5:1 이상(위 머리 주석의 잰 값). */
export const SEQUENTIAL_TEXT: readonly ("var(--text)" | "var(--bg)")[] = ["var(--text)", "var(--text)", "var(--text)", "var(--bg)", "var(--bg)"];

/** 칠하는 단계(1~5)와 칠하지 않음(0). */
export type HeatmapStep = 0 | 1 | 2 | 3 | 4 | 5;

/** 단계 1~5가 맡는 비율(값 ÷ 최댓값) 구간 — 아래는 열림, 위는 닫힘((0, 0.2] … (0.8, 1]). 범례 글에 씁니다. */
const STEP_RANGES: readonly (readonly [number, number])[] = [
  [0, 0.2],
  [0.2, 0.4],
  [0.4, 0.6],
  [0.6, 0.8],
  [0.8, 1],
];

/**
 * 값의 단계 — 0은 칠하지 않음: 값을 모름(null·undefined·NaN 등 유한하지 않은 수)·0 이하·견줄 최댓값이 0 이하(또는 유한하지 않음).
 * 그 밖은 비율(값 ÷ 최댓값)로 (0, 0.2]→1, (0.2, 0.4]→2, (0.4, 0.6]→3, (0.6, 0.8]→4, (0.8, …)→5(최댓값을 넘는 값도 5). 경계 값은 아래 단계입니다.
 */
export function heatmapStep(value: number | null | undefined, max: number): HeatmapStep {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.2) return 1;
  if (ratio <= 0.4) return 2;
  if (ratio <= 0.6) return 3;
  if (ratio <= 0.8) return 4;
  return 5;
}

/** 단계 1~5의 비율 구간 [아래, 위] — 범례 글('최댓값의 0~20%' 등)을 만드는 쪽이 씁니다. */
export function heatmapStepRange(step: 1 | 2 | 3 | 4 | 5): readonly [number, number] {
  return STEP_RANGES[step - 1];
}
