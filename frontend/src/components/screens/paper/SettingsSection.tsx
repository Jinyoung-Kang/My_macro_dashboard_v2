"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  type Column,
  DataTable,
  type InspectorContext,
  InspectorFrame,
  InspectorTrigger,
  PropertyList,
  type PropertyItem,
  SectionAnchor,
  SectionIndex,
  type SectionIndexItem,
} from "@/components/patterns";
import { Button, Callout, ErrorState, inputClasses, Loading, NativeSelect, Panel, Select, Tag } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PanelRightIcon } from "@/components/ui/icons";
import { SELECTED_BAR } from "@/components/ui/classes";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import {
  PAPER_SOURCES,
  type SettingRow,
  settingGroups,
  settingMarketLabel,
  type SettingsScope,
  settingsScopeOptions,
  type SettingsHistoryRow,
  settingsConfirmText,
  settingsDraftView,
  settingsHistoryRows,
  settingsPatch,
  settingsSaveResultView,
} from "@/lib/paper";
import type { PaperMarketCode } from "@/lib/paperMarket";
import {
  settingDescriptionRest,
  settingGroupAnchorId,
  settingGroupNavLabel,
  settingInspectorProperties,
  settingInspectorTitle,
  settingKeyHistory,
  settingLeadName,
  settingNavParts,
} from "@/lib/paperSettingsInspector";
import type { PaperSettingKey, PaperSettingsHistoryResponse, PaperSettingsResponse, PaperSettingsSaveResult } from "@/lib/types";

const INPUT = `w-full ${inputClasses()}`;

/** 목차 칸·닻 id — 묶음 닻(lib/paperSettingsInspector settingGroupAnchorId — 'paper-settings-{묶음}')과 겹치지 않는 이름. */
const PENDING_ID = "paper-settings-pending";
const HISTORY_ID = "paper-settings-history";
const PART_ID = { shared: "paper-settings-keys-shared", kr: "paper-settings-keys-kr" } as const;

/**
 * 설정 탭(명세 S1~S3) — 키마다 지금 값·기본값·범위·설명을 보이고 바꿔 저장합니다. 바꾼 기록(버전)은 아래 표.
 *
 * 저장 본문은 바꾼 키만 담은 patch이고(`{"키": 값}`), 형·범위는 서버가 검사합니다 — 틀리면 서버 문구(400)를 그대로 보입니다. 화면은
 * 입력 글자를 그 키의 형으로 읽기만 하고(숫자가 아니면 저장 버튼을 막음) 범위를 따로 검사하지 않습니다(같은 규칙을 두 곳에 두지 않게).
 * 규칙 책 영향 키(서버 keys[].affectsRules)를 바꾸면 저장 전에 확인 창(ConfirmDialog)에서 경고와 함께 한 번 더 묻고, 저장한 뒤에는 서버
 * warning을 그대로 보입니다(S3). 확인 창은 저장이 끝난 뒤(성공·실패 모두) 닫힙니다 — 실패하면 서버 문구가 아래 경고로 남습니다.
 *
 * 입력 중에는 설정을 자동으로 다시 읽지 않습니다 — 저장이 성공하면 설정과 이력을 다시 읽고 입력을 비웁니다.
 * 성공하면 초점을 저장 결과로 옮깁니다 — 바꿀 값이 비어 "설정 저장" 단추가 막히므로, 확인 창이 연 단추로 초점을 돌려주지 못하고
 * 초점이 문서 처음(body)으로 떨어지던 것을 막습니다(실패하면 단추가 살아 있어 확인 창이 그 단추로 돌려줌).
 *
 * <p><b>배치</b>(작업대 P6 — 명세 §7-1 '설정'): 긴 화면 목차(SectionIndex — xl 이상 왼쪽 13rem 세로 목록, 그 아래 본문 위 가로 줄)의 칸은 '바꿀 값' ·
 * 공용·미국 키(하위 칸 = 서버 묶음) · 한국 키(kr.* 묶음) · '바꾼 기록'이고, 새로 고친·바로 연 주소의 #절로 맞춥니다(alignHashOnLoad). 묶음 칸이 많아 세로
 * 목록이 화면보다 길 수 있어 그 안에서 스크롤합니다(columnScroll — QA 자료 25묶음에서 966px). 가운데는 지금처럼
 * '바꿀 값'(저장·되돌리기·확인 창) → 묶음별 편집 줄 → 바꾼 기록이고, 편집 줄 전체가 검사 칸 틀(InspectorFrame lg — 틀 52rem부터 옆 18rem, 그 아래는
 * 위쪽 대화상자 — 열면 제목에 포커스)입니다. 줄 끝 아이콘 단추('{키} 자세히')가 그 키의 검사 칸을 엽니다 — 읽기만 합니다(설명 전체·형·범위·고를 값·
 * 시장·지금 값·기본값·같은가·규칙 계좌 영향·설정 행·그 키의 바꾼 기록 — 모두 이미 읽은 두 응답의 값, 새 요청 없음). 값 입력은 가운데 줄에만 있습니다.
 * 줄의 이름은 서버 설명의 앞마디(한국어 — lib/paperSettingsInspector settingLeadName)이고 키는 그 아래 고정폭 보조 글(지금처럼 입력의 label)입니다 —
 * 입력의 이름은 둘을 잇습니다(aria-labelledby — 보이는 글이 이름 안, WCAG 2.5.3). 설명의 나머지는 그 아래 글이고 입력의 설명(aria-describedby)입니다.
 *
 * <p><b>한국 화면</b>(`market` "KR" — 사용자 결정 2026-10-29: 설정은 두 시장 공용 화면): 같은 한 행·같은 저장이고, 맨 위에 공용 행이라는 것을
 * 적고(어느 상태에서든), 보기를 '한국 + 공용'(기본 — keys[].market이 KR이거나 없음)·'전체'로 고릅니다. 미국 키에 '미국 계좌'를 붙이고(kr.* 키는 이름이 말함) 공용
 * 키는 표시가 없습니다. 바꿀 값·확인 창은 보기와 관계없이 손댄 키 전부입니다(보기를 바꿔도 고친 값이 빠지지 않음).
 */
export function SettingsSection({ market = "US" }: { market?: PaperMarketCode }) {
  const korea = market === "KR";
  const [scope, setScope] = useState<SettingsScope>("market");
  const banner = korea ? <Callout tone="neutral">{KR_SETTINGS_NOTE}</Callout> : null;
  const settings = useApi<PaperSettingsResponse>(endpoints.paper.settings);
  const history = useApi<PaperSettingsHistoryResponse>(endpoints.paper.settingsHistory);
  // 손댄 키만 담습니다(키 → 입력 글자). 손대지 않은 키는 지금 값을 그대로 보입니다.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const save = useAsyncAction(
    (patch: Record<string, unknown>) => apiPost<PaperSettingsSaveResult>(endpoints.paper.saveSettings, patch),
    "설정을 저장하지 못했습니다.",
  );
  // 저장에 성공한 횟수 — 바뀌면 그린 뒤(확인 창이 닫히고 결과가 생긴 뒤) 초점을 결과로 옮깁니다.
  const [saved, setSaved] = useState(0);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (saved > 0) resultRef.current?.focus();
  }, [saved]);

  if (settings.loading && !settings.data) return <>{banner}<Loading label="설정을 읽는 중…" /></>;
  if (settings.error) return <>{banner}<ErrorState message={settings.error} onRetry={settings.reload} /></>;
  if (!settings.data) return banner;
  if (!settings.data.available) {
    return <>{banner}<Callout tone="warn">{settings.data.message ?? "설정을 읽을 수 없습니다."}</Callout></>;
  }

  const data = settings.data;
  const allGroups = settingGroups(data);
  // 한국 화면의 기본 보기는 한국 + 공용 키 — 바꿀 값은 보기와 관계없이 전체 키로 셉니다(숨긴 키에 고친 값이 있어도 빠지지 않게).
  const groups = korea && scope === "market" ? settingGroups(data, { market: "KR" }) : allGroups;
  const parts = settingNavParts(groups);
  const { changes, errors } = settingsDraftView(allGroups, draft);
  const changedKeys = new Set(changes.map((change) => change.key));
  const errorCount = Object.keys(errors).length;
  const confirmText = settingsConfirmText(changes);
  const canSave = changes.length > 0 && errorCount === 0 && !save.busy;
  const result = save.result ? settingsSaveResultView(save.result) : null;
  // 검사 칸은 보이는 키만 — 보기를 바꿔 숨긴 키는 '고른 줄이 지금 자료에 없습니다'(검사 칸 틀의 사라진 키 안내).
  const visibleRows = new Map(parts.flatMap((part) => part.groups.flatMap((group) => group.rows.map((row) => [row.key, row] as const))));
  const keyMeta = new Map((data.keys ?? []).map((meta) => [meta.key, meta] as const));
  const historyRows = history.data?.available ? settingsHistoryRows(history.data.history, data.keys) : null;

  const navItems: SectionIndexItem[] = [
    { id: PENDING_ID, label: "바꿀 값", count: changes.length },
    ...parts.map((part) => ({
      id: PART_ID[part.key],
      label: part.label,
      count: part.count,
      children: part.groups.map((group) => ({ id: settingGroupAnchorId(group.key), label: settingGroupNavLabel(group.title), count: group.rows.length })),
    })),
    { id: HISTORY_ID, label: "바꾼 기록", count: historyRows?.length ?? null, pendingCount: history.loading && !history.data },
  ];

  const edit = (key: string, text: string) => {
    setDraft((current) => ({ ...current, [key]: text }));
    // 확인을 연 뒤 값을 또 바꾸면 확인을 닫습니다 — 확인한 내용과 저장할 내용이 달라지지 않게.
    setConfirming(false);
  };
  const submit = async () => {
    const ok = await save.run(settingsPatch(changes));
    // 성공·실패 모두 확인 창을 닫습니다(실패 사유는 아래 경고로 — 다시 저장하려면 확인을 한 번 더 거침).
    setConfirming(false);
    if (ok) {
      setDraft({});
      setSaved((count) => count + 1);
      void settings.reload();
      void history.reload();
    }
  };
  const onSave = () => {
    if (!canSave) return;
    if (confirmText) setConfirming(true);
    else void submit();
  };

  return (
    <>
      {banner}
      <SectionIndex label="설정 목차" items={navItems} columnFrom="xl" alignHashOnLoad columnScroll>
        <SectionAnchor id={PENDING_ID} columnFrom="xl">
          <Panel
            title="설정"
            subtitle={typeof data.version === "number"
              ? `지금 설정 v${data.version} — 바꾸면 버전이 하나 오르고, 재기동 없이 다음 작업부터 씁니다.`
              : "설정 행이 아직 없습니다(초기화 전) — 아래 값은 기본값입니다. 개요 탭에서 초기화하면 v1이 생깁니다."}
            source={PAPER_SOURCES.settings}
          >
            <p className="text-xs leading-relaxed text-text-3">
              형·범위는 저장할 때 서버가 검사합니다. <RulesTag>규칙 계좌 영향</RulesTag>이 붙은
              키는 규칙 계좌(동결된 대조군)의 조건을 바꿉니다(한국 키 kr.*는 한국 규칙 계좌) — 저장 전에 한 번 더 묻습니다. 결정 기록마다 그때의
              설정 버전이 남습니다.
              계좌 일시정지·재개는 보유·체결 탭에서 합니다.
            </p>
            {korea && (
              <div className="mt-3">
                <Select
                  label="보기"
                  value={scope}
                  onChange={(value) => setScope(value === "all" ? "all" : "market")}
                  options={settingsScopeOptions(data)}
                />
              </div>
            )}

            <section aria-label="바꿀 값" className="mt-4 flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-text">바꿀 값 ({changes.length})</h3>
              {changes.length === 0 ? (
                <p className="text-xs text-text-3">아직 바꾼 값이 없습니다 — 아래 키의 값을 고치면 여기에 모입니다.</p>
              ) : (
                <ul className="space-y-0.5 text-xs text-text-2">
                  {changes.map((change) => (
                    <li key={change.key} className="flex flex-wrap items-center gap-1">
                      <code className="text-text">{change.key}</code>
                      <span>: {change.from} → {change.to}</span>
                      {change.affectsRules && <RulesTag>{change.market === "KR" ? "한국 규칙 계좌 영향" : "규칙 계좌 영향"}</RulesTag>}
                    </li>
                  ))}
                </ul>
              )}
              {errorCount > 0 && (
                <p className="text-xs text-warn">형으로 읽지 못한 값이 {errorCount}개 있습니다 — 그 키 아래 문구를 보고 고친 뒤 저장하세요.</p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={onSave} disabled={!canSave}>
                  {save.busy ? "저장 중…" : "설정 저장"}
                </Button>
                <Button onClick={() => setDraft({})} disabled={save.busy || Object.keys(draft).length === 0}>
                  바꾼 값 되돌리기
                </Button>
              </div>
              <ConfirmDialog
                open={confirming && confirmText !== null}
                onOpenChange={setConfirming}
                title="규칙 계좌 영향 설정 저장"
                description={<p className="text-warn">{confirmText}</p>}
                confirmLabel={save.busy ? "저장 중…" : "저장 확인"}
                busy={save.busy}
                onConfirm={() => void submit()}
              />

              {/* 서버의 400 문구(모르는 키·형·범위 밖)를 그대로 — 어느 키가 왜 틀렸는지 서버가 적어 보냅니다. */}
              {save.error && <Callout tone="warn">{save.error}</Callout>}
              {/* 저장 결과 — 성공하면 초점이 여기로 옵니다(tabIndex -1: 스크립트로만 닿고 Tab 순서에는 넣지 않음). */}
              {result && (
                <div ref={resultRef} tabIndex={-1} className="flex flex-col gap-2 rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                  <Callout tone={result.tone}>{result.text}</Callout>
                  {result.warning && <Callout tone="warn">{result.warning}</Callout>}
                </div>
              )}
            </section>
          </Panel>
        </SectionAnchor>

        {groups.length === 0 ? (
          <Callout tone="neutral">서버가 바꿀 수 있는 설정 키를 보내지 않았습니다.</Callout>
        ) : (
          <InspectorFrame
            label="설정 키 자세히"
            layout="lg"
            dialogFocus="title"
            inspectorHint="줄 끝 단추를 누르면 그 키의 설명·범위·기본값·바꾼 기록이 이 칸에 나옵니다(읽기만 — 값은 가운데 줄에서 고칩니다)."
            titleOf={(key) => {
              const row = visibleRows.get(key);
              return row ? settingInspectorTitle(row) : null;
            }}
            renderDetail={(key) => {
              const row = visibleRows.get(key);
              return row ? (
                <SettingInspector
                  row={row}
                  meta={keyMeta.get(key) ?? null}
                  version={typeof data.version === "number" ? data.version : null}
                  history={history}
                />
              ) : null;
            }}
          >
            {(inspector) => (
              <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
                {parts.map((part) => (
                  <SectionAnchor key={part.key} id={PART_ID[part.key]} columnFrom="xl">
                    <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
                      {part.groups.map((group) => (
                        <SectionAnchor key={group.key || "general"} id={settingGroupAnchorId(group.key)} columnFrom="xl">
                          <Panel title={group.title}>
                            <div role="group" aria-label={group.title} className="flex flex-col">
                              {group.rows.map((row) => (
                                <SettingField
                                  key={row.key}
                                  row={row}
                                  // 한국 화면에서는 미국 키에만 '미국 계좌'를 붙입니다 — kr.* 키는 이름이 이미 말하고, 표시 없는 키는 공용(안내 글과 같은 규칙).
                                  marketLabel={korea && row.market === "US" ? settingMarketLabel(row.market) : null}
                                  value={draft[row.key] ?? row.initial}
                                  changed={changedKeys.has(row.key)}
                                  error={errors[row.key] ?? null}
                                  onChange={(text) => edit(row.key, text)}
                                  inspector={inspector}
                                />
                              ))}
                            </div>
                          </Panel>
                        </SectionAnchor>
                      ))}
                    </div>
                  </SectionAnchor>
                ))}
              </div>
            )}
          </InspectorFrame>
        )}

        <SectionAnchor id={HISTORY_ID} columnFrom="xl">
          <Panel title="바꾼 기록" subtitle="버전마다 바뀐 키와 그 버전의 값(최근 순)." source={PAPER_SOURCES.settings}>
            {history.loading && !history.data && <Loading label="설정 이력을 읽는 중…" />}
            {history.error && <ErrorState message={history.error} onRetry={history.reload} />}
            {history.data && !history.data.available && (
              <Callout tone="warn">{history.data.message ?? "설정 이력을 읽을 수 없습니다."}</Callout>
            )}
            {historyRows && (
              <DataTable<SettingsHistoryRow>
                caption="바꾼 기록"
                rows={historyRows}
                rowKey={(row) => row.key}
                columns={HISTORY_COLUMNS}
                emptyText="아직 설정 이력이 없습니다 — 초기화하면 v1(처음 값)이 남습니다."
                dense
                count
                scrollHint
              />
            )}
          </Panel>
        </SectionAnchor>
      </SectionIndex>
    </>
  );
}

/**
 * 규칙 계좌 영향 표지 — 공용 주의 태그(아이콘 + 글, 낭독기 '주의: ' — 명세 §3-4), 줄을 바꾸지 않습니다. 마우스 설명(title)은 감싼 span에.
 */
function RulesTag({ title, children }: { title?: string; children: string }) {
  return (
    <span title={title} className="whitespace-nowrap">
      <Tag tone="warn">{children}</Tag>
    </span>
  );
}

/** 중립 표지('미국 계좌'·'바꿈') — 공용 중립 태그, 줄을 바꾸지 않습니다. */
function NeutralTag({ children }: { children: string }) {
  return (
    <span className="whitespace-nowrap">
      <Tag>{children}</Tag>
    </span>
  );
}

/**
 * 바꾼 기록 표(공용 DataTable — 조밀 행 28px, 위 개수 줄, 좁은 화면 최소 640px + 넘김 안내 — 옛 표와 같은 넘김). 규칙 계좌 영향은 주의 태그, 아니면 '—'
 * (옛 표와 같은 표기) — 값을 모르는 칸이 아니라 영향이 없는 칸이라 공용 표의 빈 칸('—' + 낭독 '값 없음') 대신 낭독기에 '영향 없음'을 읽힙니다.
 */
const HISTORY_COLUMNS: readonly Column<SettingsHistoryRow>[] = [
  { key: "version", header: "버전", cell: (row) => <span className="font-semibold text-text">{row.version}</span>, className: "whitespace-nowrap" },
  { key: "createdAt", header: "저장 시각", cell: (row) => row.createdAt, className: "whitespace-nowrap" },
  { key: "changes", header: "바뀐 값", cell: (row) => <span className="break-keep wrap-break-word text-text-2">{row.changes}</span> },
  {
    key: "rules",
    header: "규칙 계좌 영향",
    cell: (row) => (row.rulesAffected ? (
      <RulesTag>규칙 계좌 영향</RulesTag>
    ) : (
      <span className="text-text-3">
        <span aria-hidden="true">{EMPTY}</span>
        <span className="sr-only">영향 없음</span>
      </span>
    )),
  },
];

/**
 * 한국 화면 설정 탭 머리의 안내 — 두 시장이 한 행을 함께 씀(사용자 결정 2026-10-29). 보이는 글이 미국 키의 '미국 계좌' 표시와 맞습니다.
 */
const KR_SETTINGS_NOTE =
  "설정은 두 시장이 한 행(한 버전)을 함께 씁니다 — kr.* 키는 한국 계좌, '미국 계좌' 표시 키는 미국 계좌, 표시 없는 키(모델·하루 호출 상한·정기 작업 몫 "
  + "예약·메모·단가 등)는 두 시장 공용입니다. 저장하면 버전이 하나 오르고 두 시장 모두 다음 작업부터 그 판을 읽습니다. 한국 규칙 계좌 영향 키는 저장 "
  + "전에 한 번 더 묻습니다.";

/**
 * 검사 칸(읽기만) — 키 하나의 속성(lib/paperSettingsInspector settingInspectorProperties)과 그 키의 바꾼 기록(이력 응답 최근 100판 안 — changedKeys에 그
 * 키가 든 판, 그 판 본문의 값). 이력은 탭이 이미 읽은 응답을 그대로 씁니다(새 요청 없음 — 읽는 중·오류면 그 사실만).
 */
function SettingInspector({
  row,
  meta,
  version,
  history,
}: {
  row: SettingRow;
  meta: PaperSettingKey | null;
  version: number | null;
  history: { data: PaperSettingsHistoryResponse | null; loading: boolean; error: string | null };
}) {
  const headingId = useId();
  const items: PropertyItem[] = settingInspectorProperties(row, meta, version).map((property) => ({
    label: property.label,
    // 규칙 계좌 영향은 줄의 표지와 같은 주의 태그(아이콘 + 글 — 낭독기 '주의: ').
    value: property.label === "규칙 계좌 영향" && row.affectsRules ? <Tag tone="warn">{property.value}</Tag> : property.value,
    mono: property.mono,
    block: property.block,
    emptyReason: property.emptyReason,
  }));
  const keyHistory = history.data?.available ? settingKeyHistory(history.data.history, row.key) : null;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PropertyList items={items} dense />
      <section aria-labelledby={headingId} className="min-w-0">
        <h4 id={headingId} className="mb-1 text-caption font-semibold text-text-2">바꾼 기록(최근 100판 안)</h4>
        {history.loading && !history.data ? (
          <p className="text-sm text-text-2">설정 이력을 읽는 중…</p>
        ) : history.error ? (
          <p className="text-sm text-warn">{history.error}</p>
        ) : keyHistory === null ? (
          <p className="text-sm text-text-2">{history.data?.message ?? "설정 이력을 읽을 수 없습니다."}</p>
        ) : keyHistory.length === 0 ? (
          <p className="break-keep text-sm text-text-2">최근 100판 안에 이 키를 바꾼 판이 없습니다.</p>
        ) : (
          <ol className="flex flex-col">
            {keyHistory.map((entry) => (
              <li key={entry.key} className="border-b border-border-subtle py-1.5 last:border-0">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm tabular-nums">
                  <span className="font-semibold text-text">{entry.version}</span>
                  <span className="text-text-2">{entry.createdAt}</span>
                </p>
                <p className="break-keep wrap-anywhere text-sm text-text">{entry.value}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** 설정 키 하나 — 이름(설명 앞마디)·키·배지·설명 나머지, 입력, 기본값·범위, 형 오류, 줄 끝 검사 단추. */
function SettingField({
  row,
  marketLabel,
  value,
  changed,
  error,
  onChange,
  inspector,
}: {
  row: SettingRow;
  /** 한국 화면에서 미국 키에 붙이는 '미국 계좌' — kr.*·공용 키·미국 화면은 null(표시 없음). */
  marketLabel: string | null;
  value: string;
  changed: boolean;
  error: string | null;
  onChange: (text: string) => void;
  inspector: InspectorContext;
}) {
  const id = `paper-setting-${row.key}`;
  const lead = settingLeadName(row.description);
  const rest = settingDescriptionRest(row.description);
  const leadId = `${id}-name`;
  const keyId = `${id}-key`;
  const descriptionId = rest ? `${id}-description` : undefined;
  // 입력의 이름 = 이름(앞마디) + 키 — 이름이 없으면 키 label(htmlFor)만.
  const labelledBy = lead ? `${leadId} ${keyId}` : undefined;
  const shown = inspector.shownKey === row.key;
  const meta = [
    row.missing ? "설정 행에 없음 — 기본값으로 읽음" : null,
    `기본 ${row.defaultText}`,
    row.range ? `범위 ${row.range}` : null,
    row.isDefault === false ? "기본값과 다름" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const badges = (
    <>
      {marketLabel && <NeutralTag>{marketLabel}</NeutralTag>}
      {row.affectsRules && (
        <RulesTag
          title={row.market === "KR"
            ? "한국 규칙 계좌(kr_rules, 동결된 대조군)의 조건을 바꾸는 키입니다 — 저장 전에 한 번 더 묻습니다."
            : "규칙 계좌(동결된 대조군)의 조건을 바꾸는 키입니다 — 저장 전에 한 번 더 묻습니다."}
        >
          {row.market === "KR" ? "한국 규칙 계좌 영향" : "규칙 계좌 영향"}
        </RulesTag>
      )}
      {changed && <NeutralTag>바꿈</NeutralTag>}
    </>
  );

  return (
    // 검사 칸에 보이는 줄은 중립 바탕 + 왼쪽 잉크 막대(공용 표의 고른 행과 같은 꼴 — 강조 파랑 아님, A1).
    <div
      data-setting-key={row.key}
      className={`relative flex items-start gap-2 border-b border-border/50 py-3 last:border-0 ${shown ? "bg-surface-2" : ""}`.trim()}
    >
      {shown ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="min-w-0 pl-2">
          {lead ? (
            <>
              <div className="flex flex-wrap items-center gap-1">
                <span id={leadId} className="mr-1 break-keep wrap-anywhere text-sm font-semibold text-text">{lead}</span>
                {badges}
              </div>
              <label id={keyId} htmlFor={id} className="mt-0.5 block break-all font-mono text-xs text-text-2">{row.key}</label>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              <label id={keyId} htmlFor={id} className="break-all font-mono text-xs font-semibold text-text">{row.key}</label>
              {badges}
            </div>
          )}
          {rest && <p id={descriptionId} className="mt-0.5 text-xs leading-relaxed text-text-3">{rest}</p>}
        </div>
        <div className="min-w-0">
          <SettingInput row={row} id={id} value={value} labelledBy={labelledBy} describedBy={descriptionId} onChange={onChange} />
          <p className="mt-1 text-xs text-text-3">{meta}</p>
          {error && <p className="mt-1 text-xs text-warn">{error}</p>}
        </div>
      </div>
      <InspectorTrigger inspector={inspector} itemKey={row.key} className="shrink-0 justify-center text-text-2">
        <PanelRightIcon size={16} />
        <span className="sr-only">{row.key} 자세히</span>
      </InspectorTrigger>
    </div>
  );
}

/** 여러 줄 상자 아래 안내 — 그 형을 어떻게 나눠 읽는지. */
const MULTILINE_HINT: Partial<Record<SettingRow["kind"], string>> = {
  list: "쉼표·공백으로 나눕니다.",
  phrases: "쉼표·줄바꿈으로 나눕니다(항목 안의 공백은 그대로 — 예: rate decision).",
  dates: "날짜(yyyy-MM-dd)를 쉼표·공백으로 나눕니다 — 예: 2026-11-02, 2026-12-30.",
  dateTimeMap: "한 줄에 날짜 하나 — '날짜 개장~마감'(예: 2026-11-19 10:00~16:30). 비우면 변경일 없음.",
  aliasMap: "한 줄에 종목 하나 — '종목 코드: 별칭, 별칭'(예: 000660: 하이닉스, SK하이닉스). 비우면 별칭 없음.",
};

/**
 * 키의 형에 맞는 입력 — 숫자는 글자 상자(숫자 상자는 "abc"를 빈 값으로 바꿔 무엇이 틀렸는지 보이지 않음), 참·거짓은 체크 상자,
 * 선택지가 있으면 선택 상자, 목록은 여러 줄 상자(쉼표·공백으로 나눔), 표(날짜별 개장·마감·별칭 — 한국 키)는 한 줄에 한 항목인 여러 줄
 * 상자, 날짜 하나는 글자 상자(yyyy-MM-dd — 형식은 서버가 봄). 형을 모르는 값은 바꾸지 않고 원문만 보입니다.
 */
function SettingInput({
  row,
  id,
  value,
  labelledBy,
  describedBy,
  onChange,
}: {
  row: SettingRow;
  id: string;
  value: string;
  /** 입력의 이름 — 이름(설명 앞마디)과 키 label의 id. 없으면 키 label(htmlFor)이 이름입니다. */
  labelledBy?: string;
  describedBy?: string;
  onChange: (text: string) => void;
}) {
  switch (row.kind) {
    case "boolean":
      // 감싼 label이 '예·아니오' 글까지 누르는 자리로 넓힙니다 — 좁은 화면(lg 미만) 높이·폭 44px(QA-458, 13px 상자만 눌렸음 — 폭은 '예'면 35px이던
      // 것을 QA-757에서 min-w-11로), 넓은 화면 높이·폭 24px(명세 §3-7 표 안 작은 조작 — lg:min-h-0이라 글 줄 20px이던 것, QA-757). 그래서 모든 폭에서
      // '예·아니오' 글을 눌러도 상자가 바뀝니다(저장은 그대로 '설정 저장' 단추 — 규칙 계좌 영향 키는 확인 창도). 블록 상자(flex)에 폭은
      // 내용에 맞추고(w-fit — 최소 폭까지), 누르는 자리는 행 전체가 아니라 상자와 글까지입니다. 상자의 이름은 키
      // label(htmlFor)과 설명 앞마디(aria-labelledby — 작업대 P6)이고, 켬·끔은 상자가 읽어 주므로 '예·아니오' 글은 낭독기에서 뺍니다(이름에 붙어 '키 예'로
      // 읽히지 않게).
      return (
        <label className="flex w-fit min-h-11 min-w-11 cursor-pointer items-center gap-2 text-sm text-text-2 lg:min-h-6 lg:min-w-6">
          <input
            id={id}
            type="checkbox"
            checked={value === "true"}
            aria-labelledby={labelledBy}
          aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked ? "true" : "false")}
          />
          <span aria-hidden="true">{value === "true" ? "예" : "아니오"}</span>
        </label>
      );
    case "choice":
      return (
        <NativeSelect
          id={id}
          value={value}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          wrapperClassName="block w-full sm:max-w-[22rem]"
        >
          {row.options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </NativeSelect>
      );
    case "list":
    case "phrases":
    case "dates":
    case "dateTimeMap":
    case "aliasMap": {
      // 표는 한 줄에 한 항목이라 줄 수만큼(적어도 두 줄) — 목록은 글자 길이로.
      const table = row.kind === "dateTimeMap" || row.kind === "aliasMap";
      const lines = value.split("\n").length;
      return (
        <>
          <textarea
            id={id}
            value={value}
            rows={table ? Math.min(Math.max(lines + 1, 2), 8) : value.length > 80 ? 4 : value.length > 40 ? 2 : 1}
            spellCheck={false}
            aria-labelledby={labelledBy}
          aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
            className={`${INPUT} font-mono text-xs`}
          />
          <p className="text-xs text-text-3">{MULTILINE_HINT[row.kind]}</p>
        </>
      );
    }
    case "json":
      return (
        <p className="text-xs text-text-3">
          <code id={id} className="break-all text-text-2">{row.current}</code> — 이 화면에서 바꾸지 않는 값입니다.
        </p>
      );
    default:
      return (
        <input
          id={id}
          type="text"
          placeholder={row.kind === "date" ? "yyyy-MM-dd" : undefined}
          inputMode={row.kind === "integer" ? "numeric" : row.kind === "number" ? "decimal" : undefined}
          value={value}
          autoComplete="off"
          spellCheck={false}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT} sm:max-w-[22rem]`}
        />
      );
  }
}
