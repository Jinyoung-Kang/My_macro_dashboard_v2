/**
 * 정보 검색 결과 목록의 매체 칸(QA 스택 기록 R3-SG3-5) — 매체 이름, 없으면 도메인, 둘 다 없으면 null('—'). 값은 모두 합성입니다.
 */
import { describe, expect, it } from "vitest";
import { publisherLabel } from "@/lib/infoSearch";

describe("publisherLabel — 결과 목록·묶음 미리 보기의 매체 칸", () => {
  it("이름이 있으면 이름(앞뒤 공백만 뗌)", () => {
    expect(publisherLabel({ publisher: "Kalsynth Media", publisherDomain: "www.kalsynthmedia.example" })).toEqual({ text: "Kalsynth Media", domain: false });
    expect(publisherLabel({ publisher: "  Synth Wire ", publisherDomain: null })).toEqual({ text: "Synth Wire", domain: false });
  });

  it("이름이 없거나 빈 글이면 도메인(받은 그대로 — 묶음 매체 수도 그것으로 셈)", () => {
    expect(publisherLabel({ publisher: null, publisherDomain: "www.kalsynthmedia.example" })).toEqual({ text: "www.kalsynthmedia.example", domain: true });
    expect(publisherLabel({ publisher: "   ", publisherDomain: " news.synth.example " })).toEqual({ text: "news.synth.example", domain: true });
  });

  it("둘 다 없으면 null — 화면은 '—'(0이나 빈 글로 채우지 않음)", () => {
    expect(publisherLabel({ publisher: null, publisherDomain: null })).toBeNull();
    expect(publisherLabel({ publisher: "", publisherDomain: "  " })).toBeNull();
  });
});
