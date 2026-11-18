import { EMPTY, formatKst, formatNumber } from "./format";
import { type SettingGroup, settingMarketLabel, type SettingRow, settingText, settingValueAt } from "./paper";
import type { PaperSettingKey } from "./types";

/**
 * 모의매매 설정 탭의 순수 규칙(작업대 P6 — 명세 §7-1 '설정': 왼쪽 묶음 목차 + 가운데 속성 편집 목록 + 오른쪽 검사 칸). React를 모릅니다(ADR 0004).
 * 값은 모두 화면이 이미 읽는 `GET /api/paper/settings`(keys[]·body·defaults)와 `GET /api/paper/settings/history`에서 옵니다 — 새 요청·새 문구 없음.
 *
 * - 이름: 서버가 키마다 한국어 이름을 보내지 않으므로(keys[]에 description뿐) 설명의 앞마디를 이름으로 씁니다(`settingLeadName` — 괄호 밖 첫 ' — ' 앞,
 *   없으면 설명 전체). 괄호 안의 ' — '(예 '미국 매매 수수료(bp, … — 토스 미국 0.1% = 10, ADR 0030)')에서는 가르지 않습니다 — 괄호가 짝을 잃은 이름이 되지
 *   않게. 나머지(`settingDescriptionRest`)는 줄의 설명 글이고, 둘을 이으면 서버 설명 그대로입니다. 설명이 없으면 이름도 없습니다(키가 이름).
 * - 목차: 묶음(lib/paper settingGroups — 서버 키 순서의 첫 마디)을 두 칸으로 — 한국 키(kr.*)와 그 밖(공용·미국 키). 하위 칸 이름은 묶음 제목의 짧은
 *   앞마디(`settingGroupNavLabel`)입니다(괄호 앞, ' — '로 가른 앞마디 — 시장 앞마디 '미국 계좌'·'한국 계좌'는 칸이 말하므로 뒷마디).
 * - 검사 칸: 키 하나의 속성(`settingInspectorProperties` — 설명 전체·형·범위·고를 값·시장·지금 값·기본값·같은가·규칙 계좌 영향·설정 행)과 그 키의 바꾼
 *   기록(`settingKeyHistory` — 이력 응답(최근 100판)에서 changedKeys에 그 키가 든 판과 그 판 본문의 값).
 */

/** 괄호 밖 첫 ' — '의 자리 — 없으면 -1. 둥근·대괄호의 깊이를 셉니다(짝이 맞지 않는 닫는 괄호는 0에서 멈춤). */
function topLevelDash(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(" || char === "（" || char === "[") depth += 1;
    else if (char === ")" || char === "）" || char === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.startsWith(" — ", index)) return index;
  }
  return -1;
}

const clean = (text: string | null | undefined) => (typeof text === "string" ? text.trim() : "");

/** 설명의 앞마디(이름) — 괄호 밖 첫 ' — ' 앞, 없으면 설명 전체. 설명이 없으면 null. */
export function settingLeadName(description: string | null | undefined): string | null {
  const text = clean(description);
  if (text === "") return null;
  const at = topLevelDash(text);
  return at < 0 ? text : text.slice(0, at).trim() || text;
}

/** 설명에서 이름(앞마디) 뒤의 글 — 괄호 밖 ' — '가 없으면 null(이름이 설명 전체). */
export function settingDescriptionRest(description: string | null | undefined): string | null {
  const text = clean(description);
  const at = topLevelDash(text);
  if (at < 0) return null;
  const rest = text.slice(at + 3).trim();
  return rest === "" || text.slice(0, at).trim() === "" ? null : rest;
}

/** 검사 칸·대화상자의 제목 — '{이름} · {키}'(이름이 겹치는 키 — 'OS 게이트 참고' 여섯 — 를 가르게), 이름이 없으면 키. */
export function settingInspectorTitle(row: Pick<SettingRow, "key" | "description">): string {
  const lead = settingLeadName(row.description);
  return lead === null ? row.key : `${lead} · ${row.key}`;
}

/** 키 하나의 바꾼 기록 줄. */
export type SettingKeyHistoryRow = {
  key: string;
  /** "v12" */
  version: string;
  /** 저장 시각(KST 표기) — 모르면 "—". */
  createdAt: string;
  /** 그 판 본문의 그 키 값(설정 값 표기) — 본문을 보내지 않았거나 키가 없으면 "—". */
  value: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 키 하나의 바꾼 기록 — 이력(서버 순서 그대로, 최근 순) 가운데 changedKeys에 그 키가 든 판만. 값은 그 판 본문에서 점 경로로 찾습니다(lib/paper
 * settingValueAt — 바꾼 기록 표와 같은 길). 처음 판(changedKeys 빈 목록 — '처음 값')은 바꾼 판이 아니라 넣지 않습니다.
 */
export function settingKeyHistory(history: unknown, key: string): SettingKeyHistoryRow[] {
  if (!Array.isArray(history)) return [];
  return history.filter(isRecord).flatMap((entry, index) => {
    const changed = Array.isArray(entry.changedKeys) ? entry.changedKeys.filter((name): name is string => typeof name === "string") : [];
    if (!changed.includes(key)) return [];
    const version = typeof entry.version === "number" && Number.isFinite(entry.version) ? entry.version : null;
    const value = isRecord(entry.body) ? settingValueAt(entry.body, key) : undefined;
    return [{
      key: `${index}-${version ?? "unknown"}`,
      version: version === null ? EMPTY : `v${formatNumber(version, 0)}`,
      createdAt: formatKst(typeof entry.createdAtKst === "string" ? entry.createdAtKst : null),
      value: value === undefined ? EMPTY : settingText(value),
    }];
  });
}

/** 검사 칸 속성 한 줄 — 값이 null이면 화면이 '—'(PropertyList). */
export type SettingInspectorProperty = {
  label: string;
  value: string | null;
  /** 식별자(키·형) — 고정폭. */
  mono?: boolean;
  /** 긴 글(설명) — 이름 위·값 아래. */
  block?: boolean;
  /** 값을 모르는 까닭('—' 옆). */
  emptyReason?: string;
};

/**
 * 키 하나의 검사 칸 속성(읽기만 — 값 입력은 가운데 목록). 형은 서버 표기 그대로(keys[].type, 없으면 화면이 정한 입력 종류), 범위는 서버 min·max
 * 그대로(lib/paper settingRangeText), 시장은 설정 탭의 시장 이름표와 같은 말, '규칙 계좌 영향'은 키 시장의 규칙 계좌 이름으로 적습니다.
 * `version`은 지금 설정 판(설정 행이 없으면 null — 그때 모든 키가 '설정 행에 없음').
 */
export function settingInspectorProperties(
  row: SettingRow,
  meta: Pick<PaperSettingKey, "type"> | null | undefined,
  version: number | null | undefined,
): SettingInspectorProperty[] {
  const type = clean(meta?.type);
  const hasVersion = typeof version === "number" && Number.isFinite(version);
  return [
    { label: "설명", value: clean(row.description) || null, block: true, emptyReason: "서버가 설명을 보내지 않음" },
    { label: "키", value: row.key, mono: true },
    { label: "형", value: type || row.kind, mono: true },
    { label: "범위", value: row.range, emptyReason: "정한 범위 없음" },
    { label: "고를 수 있는 값", value: row.kind === "choice" && row.options.length > 0 ? row.options.join(" · ") : null, emptyReason: "고르는 키가 아님" },
    { label: "시장", value: settingMarketLabel(row.market) },
    { label: "지금 값", value: row.current },
    { label: "기본값", value: row.defaultText === EMPTY ? null : row.defaultText, emptyReason: "서버가 기본값을 보내지 않음" },
    { label: "기본값과 같은가", value: row.isDefault === null ? null : row.isDefault ? "같음" : "다름", emptyReason: "기본값을 모름" },
    {
      label: "규칙 계좌 영향",
      value: row.affectsRules ? (row.market === "KR" ? "한국 규칙 계좌 영향" : "규칙 계좌 영향") : "없음",
    },
    {
      label: "설정 행",
      value: row.missing
        ? "설정 행에 없음 — 기본값으로 읽음"
        : hasVersion
          ? `있음(설정 v${formatNumber(version, 0)})`
          : "설정 행 없음(초기화 전) — 기본값으로 읽음",
    },
  ];
}

/** 목차 하위 칸 이름 — 묶음 제목의 괄호 앞을 ' — '로 가른 앞마디(시장 앞마디 '미국 계좌'·'한국 계좌'면 뒷마디). 이름이 없는 묶음은 제목 그대로. */
export function settingGroupNavLabel(title: string): string {
  const text = clean(title);
  const paren = text.search(/[(（]/);
  const head = (paren > 0 ? text.slice(0, paren) : text).trim();
  const [first, ...rest] = head.split(" — ");
  const tail = rest.join(" — ").trim();
  if ((first === "미국 계좌" || first === "한국 계좌") && tail !== "") return tail;
  return first.trim() || text;
}

/** 목차 첫 단계 칸 — 한국 키(kr.*) 묶음과 그 밖 묶음. */
export type SettingNavPart = { key: "shared" | "kr"; label: string; groups: SettingGroup[]; count: number };

/**
 * 묶음들을 목차의 두 칸으로 — 그 밖(공용·미국 키)이 먼저, 한국 키(kr.*)가 뒤. 묶음 차례는 서버 키 순서 그대로(칸 안에서). 묶음이 없는 칸은 뺍니다.
 * 그 밖 칸의 이름은 보이는 키에 미국 키가 있으면 '공용·미국 키', 없으면(한국 화면의 '한국 + 공용' 보기) '공용 키'입니다.
 */
export function settingNavParts(groups: readonly SettingGroup[]): SettingNavPart[] {
  const kr = groups.filter((group) => group.key === "kr" || group.key.startsWith("kr."));
  const shared = groups.filter((group) => !(group.key === "kr" || group.key.startsWith("kr.")));
  const count = (list: readonly SettingGroup[]) => list.reduce((sum, group) => sum + group.rows.length, 0);
  const hasUs = shared.some((group) => group.rows.some((row) => row.market === "US"));
  const parts: SettingNavPart[] = [];
  if (shared.length > 0) parts.push({ key: "shared", label: hasUs ? "공용·미국 키" : "공용 키", groups: shared, count: count(shared) });
  if (kr.length > 0) parts.push({ key: "kr", label: "한국 키", groups: kr, count: count(kr) });
  return parts;
}

/** 묶음 닻 id — 'paper-settings-{묶음}'(묶음 키의 점은 '-'로, 빈 키(일반)는 'general'). */
export function settingGroupAnchorId(groupKey: string): string {
  return `paper-settings-${groupKey === "" ? "general" : groupKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}
