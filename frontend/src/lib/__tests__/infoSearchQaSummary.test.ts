/**
 * 정보 검색 AI 요약(계약 §9-6·§9-9) QA 재현 — 요약 패널의 안내 글. 표본은 모두 합성 값입니다.
 *  - QA-427: 요약에 들지 않은 출처(offlineSources)의 사유를 하나로 단정하지 않음.
 *  - QA-428: 실패 글의 앞머리('요약하지 못했습니다')는 화면이 한 번만 붙임 — 서버 사유는 본문만(고침은 백엔드, 여기서는 받은 모양의 글을 고정).
 */
import { describe, expect, it } from "vitest";
import { summaryErrorText, summaryOfflineText, summaryUnavailableText } from "@/lib/infoSearch";

describe("QA-427 요약에 들지 않은 출처의 사유(summaryOfflineText)", () => {
  // QA-427: offlineSources에는 받은 지 15분이 지난 성공, 60초가 지난 실패, 아직 부르지 않은 출처가 섞임(수집기 출처 캐시가 지난 뒤에는
  // 셋을 가를 수 없음). 수정 전에는 글이 '받은 지 15분이 지나 서버에 남아 있지 않음'으로 단정하고, 받지 못한 출처에도 새로 받으면
  // '들어갑니다'라고 약속했음.
  it("받아 둔 결과가 없는 까닭을 셋 모두 적고, 새로 받기에 성공해야 들어간다고 적음", () => {
    const text = summaryOfflineText({ offlineSources: ["google_en", "bing"] }) ?? "";
    expect(text).toContain("요약에 들지 않은 출처: 구글 뉴스(영어)·Bing 뉴스");
    expect(text).not.toContain("받은 지 15분이 지나 서버에");
    expect(text).toContain("15분");
    expect(text).toContain("받지 못했");
    expect(text).toContain("아직 부르지 않");
    expect(text).toContain("성공");
  });
});

describe("QA-428 실패 글의 앞머리는 한 번만(summaryUnavailableText·summaryErrorText)", () => {
  class FakeApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  const once = (text: string) => expect(text.match(/요약하지 (못|않)했|요약을 만들지 못했/g)).toHaveLength(1);

  // QA-428: 서버의 engine_failed 사유가 '요약을 만들지 못했습니다 — '로 시작해 화면 앞머리와 겹쳤음. 고친 서버는 엔진별 사유 본문만 보냄.
  it("엔진 실패(engine_failed) — 엔진별 사유 본문 앞에 앞머리 하나", () => {
    const text = summaryUnavailableText({ available: false, message: "Gemini: 합성 응답 시간 초과 / Claude: 합성 응답 시간 초과" });
    expect(text).toBe("요약하지 못했습니다 — Gemini: 합성 응답 시간 초과 / Claude: 합성 응답 시간 초과");
    once(text);
  });

  it("하루 글자 상한(429) — 사유 본문에 '요약하지 않았습니다'가 없어 앞머리 하나", () => {
    const text = summaryErrorText(
      new FakeApiError("오늘 AI 글자 상한(번역과 함께 원문 1,000자)에 닿았습니다(오늘 990자 씀) — 내일(KST) 다시 됩니다", 429),
    );
    expect(text.startsWith("요약하지 못했습니다 — 오늘 AI 글자 상한")).toBe(true);
    once(text);
  });
});
