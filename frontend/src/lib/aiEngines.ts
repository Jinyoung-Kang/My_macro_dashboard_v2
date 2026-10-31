/**
 * AI 리포트 화면의 엔진 선택 규칙 — React를 모르는 순수 함수(ADR 0004).
 *
 * 배포마다 쓸 엔진을 백엔드가 좁힐 수 있습니다(AI_ENGINES, ADR 0014). 못 쓰는 엔진은 목록에서 빼지 않고 막아 두고,
 * 왜 못 쓰는지 라벨에 적습니다(`Select`의 disabled 설명과 같은 이유).
 */
import { withoutLeadingIcon } from "./format";
import type { AiEngine, AiQuota } from "./types";

/** 못 쓰는 이유별 라벨 꼬리. 이유를 모르는(예전 백엔드) 경우는 예전 문구 "키 없음"입니다. */
function unavailableSuffix(engine: AiEngine): string {
  if (engine.available) return "";
  return engine.unavailableReason === "not_allowed" ? " (이 배포에서 사용 안 함)" : " (키 없음)";
}

/**
 * 엔진 이름 — 백엔드 라벨의 앞 그림 문자(제공자 색 원·번개)는 화면에서 뗍니다. 제공자 이름이 라벨 글에 이미 있습니다
 * ('Anthropic — Claude Haiku 5.5'). 라벨이 비면 엔진 id.
 */
export function engineLabel(engine: Pick<AiEngine, "id" | "label">): string {
  return withoutLeadingIcon(engine.label ?? "") || engine.id;
}

/** 엔진 선택지 — 고르기 전에 속도를 보여 주고, 못 쓰는 엔진은 이유를 붙여 막습니다. */
export function engineOptions(engines: readonly AiEngine[]): { value: string; label: string; disabled: boolean }[] {
  return engines.map((engine) => ({
    value: engine.id,
    label: `${engineLabel(engine)}${engine.speedHint ? ` · ${engine.speedHint}` : ""}${unavailableSuffix(engine)}`,
    disabled: !engine.available,
  }));
}

/**
 * 처음 고를 엔진 — 자동 탐색을 쓸 수 있으면 `auto`, 아니면 처음 나오는 쓸 수 있는 엔진(AWS 데모는 Claude Haiku 5.5).
 * 목록을 아직 모르거나 쓸 수 있는 엔진이 없으면 `auto`(그때는 생성 버튼이 꺼져 있음).
 */
export function defaultEngineId(engines: readonly AiEngine[] | undefined): string {
  if (!engines) return "auto";
  if (engines.some((engine) => engine.id === "auto" && engine.available)) return "auto";
  return engines.find((engine) => engine.available)?.id ?? "auto";
}

/** 데모 열람의 생성 버튼 옆 안내 — 방문자 전체가 하루 한도를 함께 씁니다(ADR 0014). 한도를 모르면 숫자 없이. */
export function demoQuotaNote(quota: AiQuota | null | undefined): string {
  if (quota && quota.limit !== null && quota.limit !== undefined) {
    return `데모 방문자 전체가 하루 ${quota.limit}건을 함께 씁니다(오늘 ${quota.used}건 사용).`;
  }
  return "데모 방문자 전체가 하루 한도를 함께 씁니다.";
}

/** 결과 카드의 사용량 표기. 데모 공용 한도면 "데모 전체"를 붙입니다. */
export function quotaLabel(quota: AiQuota): string {
  return `${quota.shared ? "데모 전체 " : ""}오늘 ${quota.used}/${quota.limit ?? "무제한"}건`;
}
