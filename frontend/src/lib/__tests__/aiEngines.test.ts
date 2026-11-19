import { describe, expect, it } from "vitest";
import { defaultEngineId, demoQuotaNote, engineAvailability, engineLabel, engineOptions, quotaLabel } from "../aiEngines";
import type { AiEngine } from "../types";

function engine(id: string, available: boolean, unavailableReason: AiEngine["unavailableReason"] = null): AiEngine {
  return { id, label: id.toUpperCase(), provider: id, model: null, description: "", speedHint: "빠름", available, unavailableReason };
}

/** AWS 데모(AI_ENGINES=anthropic_haiku, ADR 0014)의 엔진 목록 모양. */
const AWS = [
  engine("auto", false, "not_allowed"),
  engine("anthropic_haiku", true),
  engine("nvidia_nemotron", false, "not_allowed"),
];

describe("엔진 선택지", () => {
  // QA-850: 속도 안내는 선택지 글에 싣지 않습니다(고르기 상자에서 잘림) — 이름 + 못 쓰는 이유 꼬리만.
  it("못 쓰는 엔진은 막고 이유를 붙인다 — 허용 목록 밖은 '이 배포에서 사용 안 함', 키 없음은 예전 문구(속도 안내는 싣지 않음)", () => {
    expect(engineOptions([...AWS, engine("cerebras_llama", false, "no_key")])).toEqual([
      { value: "auto", label: "AUTO (이 배포에서 사용 안 함)", disabled: true },
      { value: "anthropic_haiku", label: "ANTHROPIC_HAIKU", disabled: false },
      { value: "nvidia_nemotron", label: "NVIDIA_NEMOTRON (이 배포에서 사용 안 함)", disabled: true },
      { value: "cerebras_llama", label: "CEREBRAS_LLAMA (키 없음)", disabled: true },
    ]);
  });

  it("이유가 없는(예전 백엔드) 못 쓰는 엔진은 '키 없음'", () => {
    const old: AiEngine = { id: "x", label: "X", provider: "x", model: null, description: "", available: false };
    expect(engineOptions([old])).toEqual([{ value: "x", label: "X (키 없음)", disabled: true }]);
  });

  it("쓸 수 있는지의 글(고르기 아래 속성) — 쓸 수 있음·이 배포에서 사용 안 함·키 없음(이유 모름 포함)", () => {
    expect(engineAvailability({ available: true, unavailableReason: null })).toBe("쓸 수 있음");
    expect(engineAvailability({ available: false, unavailableReason: "not_allowed" })).toBe("이 배포에서 사용 안 함");
    expect(engineAvailability({ available: false, unavailableReason: "no_key" })).toBe("키 없음");
    expect(engineAvailability({ available: false })).toBe("키 없음");
  });
});

describe("처음 고를 엔진", () => {
  it("자동 탐색을 쓸 수 있으면 auto(지금과 같음)", () => {
    expect(defaultEngineId([engine("auto", true), engine("anthropic_haiku", true)])).toBe("auto");
  });

  it("자동 탐색을 못 쓰면 쓸 수 있는 첫 엔진 — AWS 데모는 Claude Haiku 5.5", () => {
    expect(defaultEngineId(AWS)).toBe("anthropic_haiku");
  });

  it("목록을 모르거나 쓸 수 있는 엔진이 없으면 auto", () => {
    expect(defaultEngineId(undefined)).toBe("auto");
    expect(defaultEngineId([engine("auto", false, "no_key"), engine("anthropic_haiku", false, "no_key")])).toBe("auto");
  });
});

describe("데모 공용 한도 안내", () => {
  it("한도를 알면 숫자와 오늘 사용량, 모르면 숫자 없이", () => {
    expect(demoQuotaNote({ used: 3, limit: 20, shared: true })).toBe("데모 방문자 전체가 하루 20건을 함께 씁니다(오늘 3건 사용).");
    expect(demoQuotaNote(undefined)).toBe("데모 방문자 전체가 하루 한도를 함께 씁니다.");
    expect(demoQuotaNote({ used: 0, limit: null })).toBe("데모 방문자 전체가 하루 한도를 함께 씁니다.");
  });

  it("결과 카드의 사용량 — 데모 공용 한도면 '데모 전체', 운영자는 '상한 없음'(QA-456)", () => {
    expect(quotaLabel({ used: 4, limit: 20, shared: true })).toBe("데모 전체 오늘 4/20건");
    expect(quotaLabel({ used: 4, limit: 20 })).toBe("오늘 4/20건");
    expect(quotaLabel({ used: 9, limit: null })).toBe("오늘 9건(상한 없음)");
  });
});

describe("엔진 이름 — 백엔드 라벨의 앞 그림 문자(제공자 색 원·번개)는 화면에서 뗀다", () => {
  it("예전 라벨은 기호를 떼고, 새 라벨은 그대로, 비면 id", () => {
    expect(engineLabel({ id: "auto", label: "⚡ 자동 탐색 — 권장 (Failover)" })).toBe("자동 탐색 — 권장 (Failover)");
    expect(engineLabel({ id: "anthropic_haiku", label: "🟣 Anthropic — Claude Haiku 5.5" })).toBe("Anthropic — Claude Haiku 5.5");
    expect(engineLabel({ id: "cerebras_llama", label: "Cerebras — Llama 3.3 70B" })).toBe("Cerebras — Llama 3.3 70B");
    expect(engineLabel({ id: "x", label: "" })).toBe("x");
  });

  it("선택지 라벨도 같은 이름 + 못 쓰는 이유(속도는 싣지 않음 — QA-850)", () => {
    const options = engineOptions([
      { id: "nvidia_nemotron", label: "🟢 NVIDIA — Nemotron-3 Super 120B", provider: "nvidia", model: null, description: "",
        available: false, unavailableReason: "no_key", speedHint: "느림" },
    ] as never);
    expect(options).toEqual([{ value: "nvidia_nemotron", label: "NVIDIA — Nemotron-3 Super 120B (키 없음)", disabled: true }]);
  });
});
