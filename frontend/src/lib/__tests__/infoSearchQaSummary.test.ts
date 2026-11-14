/**
 * 정보 검색 AI 요약(계약 §9-6·§9-9) QA 재현 — 요약 패널의 안내 글. 표본은 모두 합성 값입니다.
 *  - QA-427: 요약에 들지 않은 출처(offlineSources)의 사유를 하나로 단정하지 않음.
 */
import { describe, expect, it } from "vitest";
import { summaryOfflineText } from "@/lib/infoSearch";

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
