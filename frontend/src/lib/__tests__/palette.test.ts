/**
 * 명령 팔레트 순수 함수(lib/palette) — 최근 연 대상의 저장 형식 검사(종류 넷·상세 화면 세 경로·글 길이·판), 맨 앞에 넣기·같은 주소 하나·8개 상한,
 * 결과 행으로 바꾸기(원판은 종류대로), 고른 결과에서 만들기(메뉴는 넣지 않음).
 */
import { describe, expect, it } from "vitest";
import type { SearchEntry } from "../search";
import {
  RECENT_GROUP_LABEL,
  RECENT_LIMIT,
  RECENT_STORAGE_KEY,
  parseRecent,
  pushRecent,
  recentEntries,
  recentFromEntry,
  serializeRecent,
  type RecentEntity,
} from "../palette";

const APPLE: RecentEntity = { kind: "ticker", label: "Apple Inc.", sub: "AAPL · Technology", href: "/s/us/AAPL", dest: "종목 상세" };
const SP500: RecentEntity = { kind: "indicator", label: "S&P 500", sub: "주가지수 · ^GSPC", href: "/markets/i/sp500", dest: "지표 상세" };
const BERKSHIRE: RecentEntity = {
  kind: "institution", label: "버크셔 해서웨이 (Berkshire Hathaway)", sub: "13F · CIK 0001067983", href: "/institutions/0001067983", dest: "기관 상세",
};
const SAMSUNG: RecentEntity = { kind: "symbol", label: "삼성전자", sub: "005930 · 코스피", href: "/s/kr/005930", dest: "종목 상세" };

const stored = (items: unknown[], v: unknown = 1) => JSON.stringify({ v, items });

describe("최근 연 대상 — 상수", () => {
  it("저장 키·상한·묶음 이름", () => {
    expect(RECENT_STORAGE_KEY).toBe("shell.palette.recent");
    expect(RECENT_LIMIT).toBe(8);
    expect(RECENT_GROUP_LABEL).toBe("최근 연 대상");
  });
});

describe("parseRecent — 읽을 때 형식 검사", () => {
  it("비었거나 깨진 JSON·다른 판·items가 배열이 아니면 빈 목록(던지지 않음)", () => {
    for (const raw of [null, undefined, "", "{", "null", "[]", "42", stored([APPLE], 2), JSON.stringify({ v: 1, items: "x" }), JSON.stringify({ items: [APPLE] })]) {
      expect(parseRecent(raw), String(raw)).toEqual([]);
    }
  });

  it("종류 넷(지표·기관·종목·종목 찾기)과 그 상세 화면 주소만 남긴다", () => {
    expect(parseRecent(stored([APPLE, SP500, BERKSHIRE, SAMSUNG]))).toEqual([APPLE, SP500, BERKSHIRE, SAMSUNG]);
  });

  it("바뀐 저장값이 다른 주소로 보내지 않는다 — javascript:·운영자 화면·쿼리·조각·바깥 주소·종류와 맞지 않는 경로는 버린다", () => {
    const bad = [
      { ...APPLE, href: "javascript:alert(1)" },
      { ...APPLE, href: "/admin/users" },
      { ...APPLE, href: "https://example.com/s/us/AAPL" },
      { ...APPLE, href: "//example.com/s/us/AAPL" },
      { ...APPLE, href: "/s/us/AAPL?next=/admin" },
      { ...APPLE, href: "/s/us/AAPL#x" },
      { ...APPLE, href: "/s/us/AAPL/extra" },
      { ...APPLE, href: "/s/jp/7203" },
      { ...SAMSUNG, href: "/s/kr/5930" },
      { ...SP500, href: "/markets/i/s p 500" },
      { ...SP500, href: "/s/us/AAPL" },
      { ...BERKSHIRE, href: "/institutions/berkshire" },
      { ...BERKSHIRE, href: "/markets/i/sp500" },
      { ...APPLE, kind: "menu", href: "/macro" },
      { ...APPLE, kind: "unknown" },
      "문자열",
      null,
    ];
    expect(parseRecent(stored([...bad, APPLE]))).toEqual([APPLE]);
  });

  it("주소는 lib/detail parse로 다시 풀어 만든 것을 쓴다 — 소문자 티커는 대문자로", () => {
    expect(parseRecent(stored([{ ...APPLE, href: "/s/us/aapl" }]))[0].href).toBe("/s/us/AAPL");
  });

  it("글 칸은 200자까지 — 넘거나 이름이 비었거나 글이 아니면 버린다, 보조 글·도착 화면은 null이어도 된다", () => {
    const long = "가".repeat(201);
    expect(parseRecent(stored([{ ...APPLE, label: long }, { ...APPLE, label: " " }, { ...APPLE, sub: 3 }, { ...APPLE, dest: long }]))).toEqual([]);
    expect(parseRecent(stored([{ ...APPLE, label: "가".repeat(200), sub: null, dest: null }]))).toEqual([
      { ...APPLE, label: "가".repeat(200), sub: null, dest: null },
    ]);
  });

  it("같은 주소는 처음 것 하나, 8개까지", () => {
    const many = Array.from({ length: 12 }, (_, at) => ({ ...APPLE, label: `종목 ${at}`, href: `/s/us/T${at}` }));
    const parsed = parseRecent(stored([APPLE, { ...APPLE, label: "중복" }, ...many]));
    expect(parsed).toHaveLength(RECENT_LIMIT);
    expect(parsed[0]).toEqual(APPLE);
    expect(parsed.filter((entity) => entity.href === "/s/us/AAPL")).toHaveLength(1);
  });
});

describe("pushRecent·serializeRecent", () => {
  it("맨 앞에 넣고 같은 주소의 옛 항목을 빼며 8개까지 — 형식 밖이면 그대로", () => {
    let list: RecentEntity[] = [];
    list = pushRecent(list, APPLE);
    list = pushRecent(list, SP500);
    list = pushRecent(list, { ...APPLE, label: "Apple" });
    expect(list.map((entity) => entity.label)).toEqual(["Apple", "S&P 500"]);
    for (let at = 0; at < 10; at += 1) list = pushRecent(list, { ...APPLE, href: `/s/us/T${at}` });
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0].href).toBe("/s/us/T9");
    expect(pushRecent(list, { ...APPLE, href: "javascript:alert(1)" })).toEqual(list);
  });

  it("저장 글은 판 1과 항목 — 다시 읽으면 같은 목록", () => {
    const list = [SAMSUNG, BERKSHIRE];
    expect(JSON.parse(serializeRecent(list))).toEqual({ v: 1, items: list });
    expect(parseRecent(serializeRecent(list))).toEqual(list);
  });
});

describe("결과 행", () => {
  it("recentEntries — id는 'recent:'+주소, 원판은 종류대로(지표 시장·기관 기관 아이콘·종목 티커 모노그램)", () => {
    const [apple, sp500, berkshire, samsung] = recentEntries([APPLE, SP500, BERKSHIRE, SAMSUNG]);
    expect(apple).toEqual({
      kind: "ticker", id: "recent:/s/us/AAPL", label: "Apple Inc.", sub: "AAPL · Technology", href: "/s/us/AAPL", dest: "종목 상세",
      keywords: [], avatar: { text: "AAP" },
    });
    expect(sp500.avatar).toEqual({ tab: "markets" });
    expect(berkshire.avatar).toEqual({ tab: "institutions" });
    expect(samsung.avatar).toEqual({ text: "삼" });
  });

  it("recentFromEntry — 지표·기관·종목·종목 찾기만, 메뉴는 넣지 않는다", () => {
    const entry: SearchEntry = { ...APPLE, id: "ticker:AAPL", keywords: ["AAPL"], avatar: { text: "AAP" } };
    expect(recentFromEntry(entry)).toEqual(APPLE);
    const menu: SearchEntry = { kind: "menu", id: "menu:/macro", label: "매크로 지표", sub: "시장", href: "/macro", dest: null, keywords: [] };
    expect(recentFromEntry(menu)).toBeNull();
  });
});
