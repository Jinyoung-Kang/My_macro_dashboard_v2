/**
 * 금리차 카드의 머리말 — 변화량·만기 라벨·역전 여부·부제.
 */
import type { MacroOverview } from "./types";

export type SpreadBlock = NonNullable<MacroOverview["spreads"]>["official10y2y"];

export function spreadSummary(block: SpreadBlock | null | undefined) {
  // 어느 한쪽이라도 모르면(null이든 필드가 없든) 변화도 모릅니다 — 0으로 메워 계산하지 않습니다.
  const change =
    typeof block?.latest === "number" && typeof block?.previous === "number"
      ? block.latest - block.previous
      : null;
  return {
    change,
    // 역전은 아는 값에서만 말합니다. latest를 모르는데 (?? 0) < 0 으로 '역전 아님'이라 단정하지 않습니다.
    inverted: typeof block?.latest === "number" && block.latest < 0,
    pair: `${block?.longId?.replace("DGS", "")}Y−${block?.shortId?.replace("DGS", "")}Y`,
    // 카드가 공식·스크래핑 둘을 함께 담으므로 부제도 둘을 다 적습니다. 예전 부제는 카드 전체를
    // "미 재무부 공식 일별 확정치"라고 선언해서 오른쪽 스크래핑 패널까지 확정치로 읽히게 했습니다.
    subtitle:
      `공식: FRED ${block?.longId} − ${block?.shortId} (일별 확정치)`
      + " · 스크래핑: TradingView 참고 시세 (지금 시점)",
  };
}

