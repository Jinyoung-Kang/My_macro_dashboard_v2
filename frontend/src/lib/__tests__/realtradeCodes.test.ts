/**
 * 실제 매매 화면의 코드 이름표를 백엔드 소스의 코드 상수와 대조합니다(QA-346).
 *
 * 화면의 이름표 표(lib/realtrade의 SKIP_REASON·EVENT_KIND·HALT_REASON·경고)와 백엔드가 보내는 코드가 따로 적혀 있어 어긋났습니다 — 화면 열쇠는
 * `fractional`인데 백엔드는 `fractional-part`, 이름표 없는 건너뜀 코드 여섯, 이벤트 `RESTRICTED`, 예상 목록 경고는 코드 그대로. 백엔드에 코드가
 * 늘면 이 시험이 이름표를 요구합니다(선례: endpoints.test.ts가 docs/API.md를 읽음). 모르는 코드는 화면이 받은 글자 그대로 보이므로 이름표가 없어도
 * 깨지지는 않지만, 운영자가 코드를 해석해야 합니다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { eventDetailText, eventKindLabel, haltReasonLabel, skippedText, warningText } from "@/lib/realtrade";

const JAVA = resolve(__dirname, "../../../../backend/src/main/java/com/macrodash");
const java = (path: string) => readFileSync(resolve(JAVA, path), "utf8");

/** `static final String PREFIX_이름 = "값";` 상수의 값들. */
function constants(source: string, prefix: string): string[] {
  return [...source.matchAll(new RegExp(`static final String ${prefix}\\w+\\s*=\\s*"([^"]+)"\\s*;`, "g"))].map((match) => match[1]);
}

const planner = java("feature/realtrade/RealTradePlanner.java");
const job = java("feature/realtrade/RealTradeJob.java");
const executor = java("feature/realtrade/RealTradeExecutor.java");
const notices = java("feature/realtrade/RealTradeNotices.java");
const service = java("feature/realtrade/RealTradeService.java");
const store = java("store/RealTradeStore.java");

/** 그날을 쉬는 사유(명세 §3) — 종목 건너뜀이 아니라 '오늘 쉼' 줄에 코드로 보입니다. 종목 건너뜀 이름표의 대조에서는 뺍니다. */
const DAY_SKIPS = [
  "market-closed", "calendar-date-mismatch", "paper-calendar-unknown", "hours-mismatch", "clock-skew", "clock-skew-unknown", "ledger-behind",
];

describe("QA-346: 실제 매매 화면 이름표와 백엔드 코드 상수", () => {
  it("대조할 상수를 실제로 읽었다(소스 모양이 바뀌어 빈 목록으로 통과하지 않게)", () => {
    const skips = constants(planner, "SKIP_");
    expect(skips).toEqual(expect.arrayContaining([...DAY_SKIPS, "fractional-part", "opposite-pending", "pending-stop"]));
    expect(constants(store, "EVENT_").length).toBeGreaterThanOrEqual(10);
    expect(constants(notices, "EVENT_")).toEqual(expect.arrayContaining(["STOPPED", "STOP_SELL", "RESTRICTED"]));
    expect([...constants(job, "HALT_"), ...constants(executor, "HALT_")]).toEqual(expect.arrayContaining(["turnover", "unknown-order"]));
  });

  // 수정 전: 화면 열쇠가 `fractional`이라 백엔드의 `fractional-part`에 이름표가 없고, own-pending·pending-unknown·price-missing·buys-paused·
  // weight-unknown·symbol-unsupported·paper-cancelled-after-claim도 코드 그대로 보였다.
  it("종목 건너뜀 사유 코드마다 화면 이름표가 있다 — '이름표(코드)'로 그린다", () => {
    const codes = [
      ...constants(planner, "SKIP_").filter((code) => !DAY_SKIPS.includes(code)),
      ...constants(job, "SKIP_"),
      "timing-unsupported",
      "paper-cancelled-after-claim",
    ];
    expect(job).toContain('"timing-unsupported"');
    expect(job).toContain('"paper-cancelled-after-claim"');
    const unlabeled = codes.filter((code) => !skippedText({ symbol: "005930", name: null, reason: code }).endsWith(`(${code})`));
    expect(unlabeled).toEqual([]);
  });

  // 수정 전: RESTRICTED(매매 제한으로 대기)에 이름표가 없었다.
  it("이벤트 종류마다 화면 이름표가 있다", () => {
    // 저장소에는 EVENT_COLUMNS(칸 목록) 같은 다른 상수도 있어 이벤트 종류 모양(대문자·밑줄)만 봅니다.
    const kinds = [...constants(store, "EVENT_"), ...constants(notices, "EVENT_")].filter((kind) => /^[A-Z][A-Z_]+$/.test(kind));
    expect(kinds).toEqual(expect.arrayContaining(["ENABLE", "HALT", "RESTRICTED", "UNAVAILABLE"]));
    expect(kinds.filter((kind) => eventKindLabel(kind) === kind)).toEqual([]);
  });

  it("이상 멈춤 사유 코드마다 화면 이름표가 있다", () => {
    const codes = [...constants(job, "HALT_"), ...constants(executor, "HALT_"), "restored"];
    expect(codes.filter((code) => haltReasonLabel(code) === code)).toEqual([]);
  });

  // 수정 전: 예상 목록 경고는 백엔드가 코드를 보내는데 화면은 글자 그대로 그렸다(warningText 없음).
  it("예상 목록 경고 코드는 이름표로 그린다 — 모르는 글은 받은 그대로", () => {
    const literal = [...service.matchAll(/warnings\.add\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(literal).toEqual(expect.arrayContaining(["targets-incomplete", "turnover-over-60", "equity-capped"]));
    expect(service).toContain("warnings.add(RealTradeJob.HALT_BOOK_NOT_ACTIVE)");
    for (const code of [...literal, "book-not-active"]) {
      expect(warningText(code)).toMatch(new RegExp(`.+\\(${code}\\)$`));
    }
    expect(warningText("첫 시가 맞추기는 회전율 한도 예외")).toBe("첫 시가 맞추기는 회전율 한도 예외");
  });

  // 수정 전: 창 요약의 결과 모름(unknown) 건수를 적지 않았고, 멈춤 해제 이벤트의 사유 없음이 글자 "null"로 보였다.
  it("창 요약의 결과 모름 건수를 적고, 사유가 없다는 글자 'null'은 사유로 적지 않는다", () => {
    expect(eventDetailText({ window: "MIRROR", accepted: 1, filled: 0, missed: 0, skipped: 0, blocked: 0, deferred: 0, unknown: 2 }, "WINDOW_SUMMARY"))
      .toContain("결과 모름 2");
    expect(eventDetailText({ from: "LIVE", haltReason: "null", buysPausedCleared: true }, "RESUME")).toBeNull();
  });
});
