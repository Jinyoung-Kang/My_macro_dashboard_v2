/**
 * 13F 교집합·공통 신규 매수 행의 표기 — React를 모릅니다(ADR 0004 규칙 3).
 *
 * 백엔드는 공시 이름이 아니라 증권으로 묶습니다(QA-083). 행 키는 `cusip:…`(증권 하나), 한 회사의 보통주 클래스를
 * 합친 행은 `issuer:…`(CUSIP 앞 6자리), CUSIP이 없으면 `name:…`입니다. 표시 이름은 겹칠 수 있어('ISHARES TR' 아래
 * 서로 다른 ETF, 클래스 표기가 갈려 두 행으로 남은 A·C주) 이름만 그리면 어느 행이 어느 증권인지 읽을 수 없습니다(QA-114).
 */
import { truncateToWidth, visualWidth } from "@/lib/chartAxis";

interface SecurityRow {
  key: string;
  name: string;
  /** 대표 CUSIP. 합친 행(issuer:)에서는 처음 들어온 클래스의 것이라 그 행 전체를 가리키지 않습니다. */
  cusip?: string | null;
}

/** 막대 이름표 칸의 너비 — `HorizontalBars`가 이름표를 자르는 너비(CategoryTick maxWidth)와 같아야 합니다. */
const BAR_LABEL_WIDTH = 24;

/**
 * 이름 아래 적을 증권 구분자. 합친 행은 '발행사 XXXXXX · 보통주 합산'(대표 CUSIP은 한 클래스의 것일 뿐이라 쓰지 않음),
 * 증권 하나면 'CUSIP …', CUSIP을 모르면 빈 문자열입니다.
 */
export function securityNote(row: Pick<SecurityRow, "key" | "cusip">): string {
  if (row.key.startsWith("issuer:")) {
    return `발행사 ${row.key.slice("issuer:".length)} · 보통주 합산`;
  }
  return row.cusip ? `CUSIP ${row.cusip}` : "";
}

/** 교집합 막대 차트의 막대 수 상한(위에서부터) — 화면의 처음 읽는 동안 막대 자리 높이도 이 값으로 셈합니다. */
export const CONSENSUS_BAR_LIMIT = 15;

/**
 * '공통 보유 상위 종목' 막대(값 = 보유 기관 수). 이름은 예전처럼 16자에서 자르고, <b>이름이 겹치는 행에만</b>
 * 짧은 구분자(CUSIP, 합친 행은 발행사)를 붙입니다. 구분자가 이름표 칸에서 잘리면 다시 같은 이름표가 되므로,
 * 줄이는 쪽은 이름입니다(전체 이름은 이름표에 마우스를 올리면 보입니다).
 */
export function consensusBars(
  rows: readonly (SecurityRow & { holderCount: number })[],
  limit = CONSENSUS_BAR_LIMIT,
): { name: string; value: number }[] {
  const top = rows.slice(0, limit);
  const counts = new Map<string, number>();
  top.forEach((row) => counts.set(row.name, (counts.get(row.name) ?? 0) + 1));
  return top.map((row) => {
    if ((counts.get(row.name) ?? 0) < 2) {
      return { name: row.name.length > 16 ? `${row.name.slice(0, 16)}…` : row.name, value: row.holderCount };
    }
    const id = row.key.startsWith("issuer:") ? `발행사 ${row.key.slice("issuer:".length)}` : row.cusip || row.key;
    const tag = ` · ${id}`;
    return { name: `${truncateToWidth(row.name, BAR_LABEL_WIDTH - visualWidth(tag))}${tag}`, value: row.holderCount };
  });
}
