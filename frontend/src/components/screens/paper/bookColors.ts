/**
 * 모의매매 계좌 코드별 색 — 개요의 순자산 곡선·노출 추이·'S = 100 같은 구간' 계열이 씁니다. 계좌 행 색 고리처럼 다른 화면 폴더(홈)도 같은 표를
 * 쓸 수 있게 OverviewSection에서 옮겼습니다(값·검증 기록 그대로 — Coinbase식 개편 명세 §12).
 *
 * 계열 색은 차트 배럴(`@/components/charts`)이 아니라 차트 틀(`frame.tsx` — 같은 SERIES_COLORS, recharts를 가져오지 않음)에서 가져옵니다. 배럴에서
 * 가져오면 차트가 없는 홈('/')이 색 고리 때문에 recharts 조각(약 430KB)까지 싣습니다(next build 결과로 확인 — 장중 명세 §4-1).
 */
import { SERIES_COLORS } from "@/components/charts/frame";

/**
 * 책 코드별 선 색. 앞 셋은 charts의 검증된 팔레트, 혼합 벤치마크는 회색입니다
 * (벤치마크 둘이 같은 계열색이면 어느 선이 SPY인지 범례를 다시 봐야 했음). 모르는 책은 남는 색을 돌려 씁니다.
 * dataviz 검증기(라이트 #ffffff·다크 #1a1a19): 예전 회색 #8B949E는 바로 앞 초록과 정상 시각 ΔE 13.5(15 미만)라 한 단계 어둡게
 * #6b727e(초록과 15.1·색약 8.8, 대비 4.9/3.6:1)로, 남는 색의 청록 #39C5CF는 다크 밝기 띠(0.755) 밖이라 #22a2bd로 옮겼습니다.
 * 회색은 범주 색이 아니라 채도 검사는 적용하지 않습니다.
 *
 * 다섯째 미국 계좌 Claude 계좌2(체결 시점 실험 — 계좌2 명세 §13-3)는 자주 #ba5db3(2026-11-16 — 작업대 실행 명세 §3-5). 예전 #a438a0는
 * 어두운 면 surface #1c2127 위 대비 2.82로 3:1에 못 미쳤고, 2026-11-15에 고른 #bd6bbd는 모든 쌍(--pairs all)으로 파랑과 색약 ΔE 6.3(protan — 6~8 띠는
 * 보조 부호가 있을 때만 허용)이었습니다. #ba5db3은 같은 검증기로 어두운 두 면(surface #1c2127·bg #111418)에서 대비 4.09·4.66, 밝기 띠·채도 안이고,
 * 순자산 곡선의 순서(파랑·주황·자주·초록·회색) 이웃 쌍은 모두 통과합니다(최악은 기존 초록↔회색 색약 8.8·정상 15.1). 모든 쌍으로도 자주가 낀 쌍은 모두
 * 색약 8 이상입니다 — 회색과 8.5(deutan)·정상 16.9, 파랑과 9.0(protan)·정상 19.6. 노출 추이(계좌1 주황 점선·실선과 계좌2 자주 — 작업대 P6부터 색 = 계좌)에서 두 계좌 선이 맞닿아도 색으로 갈리고,
 * 두 그림 모두 계좌 이름 범례(글자)가 함께 나릅니다.
 * 남는 색의 보라 #a371f7는 파랑과 색약 ΔE 3.9·정상 13.9, 새 자주와 정상 11.1이라 계좌 색으로 쓰지 않습니다.
 */
export const BOOK_COLORS: Record<string, string> = {
  rules: SERIES_COLORS.blue,
  claude: SERIES_COLORS.orange,
  claude2: "#ba5db3",
  bench_spy: SERIES_COLORS.green,
  bench_mix: "#6b727e",
  // 한국 네 계좌 — 미국과 같은 자리(규칙 파랑·Claude 주황·지수 초록·60/40 회색)라 같은 검증 결과를 그대로 씁니다.
  kr_rules: SERIES_COLORS.blue,
  kr_claude: SERIES_COLORS.orange,
  // 한국 Claude 계좌2(사용자 결정 2026-11-02) — 미국 계좌2와 같은 자주.
  kr_claude2: "#ba5db3",
  kr_bench_k200: SERIES_COLORS.green,
  kr_bench_mix: "#6b727e",
};
export const SPARE_COLORS = ["#a371f7", "#22a2bd", "#db6d28"];
/**
 * 한국 노출 맞춘 참고선(K40)의 색 — 옅은 중립 회색 #a7b0bd를 점선으로. 계좌 다섯(파랑·주황·자주·초록·회색) 뒤에 놓여 계좌 선과 색·선 모양 둘 다
 * 다르고, 범례 이름 '…(계좌 아님)'이 함께 뜻을 나릅니다(색은 보조).
 * 예전 보라 #a371f7(남는 색의 첫 색)는 2026-11-15의 계좌2 자주 #bd6bbd와 정상 시각 ΔE 9.7이라 바꿨습니다(작업대 실행 명세 §3-5). 어두운 밝기 띠 안에서는 다섯 계좌
 * 색 모두와 정상 시각 15를 넘는 색을 격자(OKLCH L 0.48~0.67·C 0.10~0.16)에서 찾지 못해(최선 13.1) 밝기로 갈리는 중립을 골랐습니다 — 같은 검증기로 다섯 계좌 색과
 * 정상 시각 ΔE 최소 18.7·색약 12.4(둘 다 초록 — 2026-11-16 계좌2 #ba5db3과는 20.6·14.3), 어두운 두 면(surface·bg) 위 대비 7.40·8.43. 금색 후보는 주의 색(warn)과
 * 거의 같아(ΔE 4~5) 쓰지 않았습니다.
 */
export const REFERENCE_COLOR = "#a7b0bd";

/**
 * 계좌 하나의 색 — 표에 있으면 그 색, 없으면 남는 색을 자리(`index`)대로 돌려 씁니다. 순자산 곡선의 계열 색과 계좌 행 아바타의 고리(개요·홈)가
 * 같은 규칙이라 같은 계좌가 같은 색입니다(고리는 장식 — 뜻은 계좌 이름이 나름).
 */
export function bookColor(code: string, index: number): string {
  return BOOK_COLORS[code] ?? SPARE_COLORS[((index % SPARE_COLORS.length) + SPARE_COLORS.length) % SPARE_COLORS.length];
}
