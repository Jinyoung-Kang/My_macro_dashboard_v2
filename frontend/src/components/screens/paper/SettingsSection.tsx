"use client";

import { useEffect, useRef, useState } from "react";
import { Banner, Button, Card, ErrorState, Loading, Select, Table } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
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
import type { PaperSettingsHistoryResponse, PaperSettingsResponse, PaperSettingsSaveResult } from "@/lib/types";

/** 배지 색 — lib/paper의 배지와 같은 팔레트. */
const RULES_BADGE = "border-warn/40 bg-warn/10 text-warn";
const CHANGED_BADGE = "border-accent/40 bg-accent/10 text-accent";
const INPUT = "w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-body outline-hidden focus:border-accent";

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
 * <p><b>한국 화면</b>(`market` "KR" — 사용자 결정 2026-10-29: 설정은 두 시장 공용 화면): 같은 한 행·같은 저장이고, 맨 위에 공용 행이라는 것을
 * 적고(어느 상태에서든), 보기를 '한국 + 공용'(기본 — keys[].market이 KR이거나 없음)·'전체'로 고릅니다. 키마다 '한국 책'·'미국 책'을 붙이고 공용
 * 키는 표시가 없습니다. 바꿀 값·확인 창은 보기와 관계없이 손댄 키 전부입니다(보기를 바꿔도 고친 값이 빠지지 않음).
 */
export function SettingsSection({ market = "US" }: { market?: PaperMarketCode }) {
  const korea = market === "KR";
  const [scope, setScope] = useState<SettingsScope>("market");
  const banner = korea ? <Banner tone="info">{KR_SETTINGS_NOTE}</Banner> : null;
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
    return <>{banner}<Banner tone="warn">{settings.data.message ?? "설정을 읽을 수 없습니다."}</Banner></>;
  }

  const data = settings.data;
  const allGroups = settingGroups(data);
  // 한국 화면의 기본 보기는 한국 + 공용 키 — 바꿀 값은 보기와 관계없이 전체 키로 셉니다(숨긴 키에 고친 값이 있어도 빠지지 않게).
  const groups = korea && scope === "market" ? settingGroups(data, { market: "KR" }) : allGroups;
  const { changes, errors } = settingsDraftView(allGroups, draft);
  const changedKeys = new Set(changes.map((change) => change.key));
  const errorCount = Object.keys(errors).length;
  const confirmText = settingsConfirmText(changes);
  const canSave = changes.length > 0 && errorCount === 0 && !save.busy;
  const result = save.result ? settingsSaveResultView(save.result) : null;

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
      <Card
        title="설정"
        subtitle={typeof data.version === "number"
          ? `지금 설정 v${data.version} — 바꾸면 버전이 하나 오르고, 재기동 없이 다음 작업부터 씁니다.`
          : "설정 행이 아직 없습니다(초기화 전) — 아래 값은 기본값입니다. 개요 탭에서 초기화하면 v1이 생깁니다."}
        source={PAPER_SOURCES.settings}
      >
        <p className="text-xs leading-relaxed text-muted">
          형·범위는 저장할 때 서버가 검사합니다. <span className={`rounded-sm border px-1 ${RULES_BADGE}`}>규칙 계좌 영향</span>이 붙은
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
          <h3 className="text-sm font-semibold text-bright">바꿀 값 ({changes.length})</h3>
          {changes.length === 0 ? (
            <p className="text-xs text-muted">아직 바꾼 값이 없습니다 — 아래 키의 값을 고치면 여기에 모입니다.</p>
          ) : (
            <ul className="space-y-0.5 text-xs text-body">
              {changes.map((change) => (
                <li key={change.key} className="flex flex-wrap items-center gap-1">
                  <code className="text-bright">{change.key}</code>
                  <span>: {change.from} → {change.to}</span>
                  {change.affectsRules && (
                    <span className={`rounded-sm border px-1 text-[10px] ${RULES_BADGE}`}>
                      {change.market === "KR" ? "한국 규칙 계좌 영향" : "규칙 계좌 영향"}
                    </span>
                  )}
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
          {save.error && <Banner tone="warn">{save.error}</Banner>}
          {/* 저장 결과 — 성공하면 초점이 여기로 옵니다(tabIndex -1: 스크립트로만 닿고 Tab 순서에는 넣지 않음). */}
          {result && (
            <div ref={resultRef} tabIndex={-1} className="flex flex-col gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
              <Banner tone={result.tone}>{result.text}</Banner>
              {result.warning && <Banner tone="warn">{result.warning}</Banner>}
            </div>
          )}
        </section>
      </Card>

      {groups.length === 0 ? (
        <Banner tone="info">서버가 바꿀 수 있는 설정 키를 보내지 않았습니다.</Banner>
      ) : (
        groups.map((group) => (
          <Card key={group.key || "general"} title={group.title}>
            <div role="group" aria-label={group.title} className="flex flex-col">
              {group.rows.map((row) => (
                <SettingField
                  key={row.key}
                  row={row}
                  marketLabel={korea && row.market ? settingMarketLabel(row.market) : null}
                  value={draft[row.key] ?? row.initial}
                  changed={changedKeys.has(row.key)}
                  error={errors[row.key] ?? null}
                  onChange={(text) => edit(row.key, text)}
                />
              ))}
            </div>
          </Card>
        ))
      )}

      <Card title="바꾼 기록" subtitle="버전마다 바뀐 키와 그 버전의 값(최근 순)." source={PAPER_SOURCES.settings}>
        {history.loading && !history.data && <Loading label="설정 이력을 읽는 중…" />}
        {history.error && <ErrorState message={history.error} onRetry={history.reload} />}
        {history.data && !history.data.available && (
          <Banner tone="warn">{history.data.message ?? "설정 이력을 읽을 수 없습니다."}</Banner>
        )}
        {history.data?.available && (
          <Table<SettingsHistoryRow>
            label="바꾼 기록"
            rows={settingsHistoryRows(history.data.history, data.keys)}
            rowKey={(row) => row.key}
            emptyMessage="아직 설정 이력이 없습니다 — 초기화하면 v1(처음 값)이 남습니다."
            columns={[
              { key: "version", header: "버전", render: (row) => <span className="font-semibold text-bright">{row.version}</span> },
              { key: "createdAt", header: "저장 시각", render: (row) => <span className="whitespace-nowrap">{row.createdAt}</span> },
              { key: "changes", header: "바뀐 값", render: (row) => <span className="text-xs text-body">{row.changes}</span> },
              {
                key: "rules",
                header: "규칙 계좌 영향",
                render: (row) => (row.rulesAffected
                  ? <span className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${RULES_BADGE}`}>규칙 계좌 영향</span>
                  : <span className="text-muted">{EMPTY}</span>),
              },
            ]}
          />
        )}
      </Card>
    </>
  );
}

/**
 * 한국 화면 설정 탭 머리의 안내 — 두 시장이 한 행을 함께 씀(사용자 결정 2026-10-29). 보이는 글이 키마다의 '한국 책'·'미국 책' 표시와 맞습니다.
 */
const KR_SETTINGS_NOTE =
  "설정은 두 시장이 한 행(한 버전)을 함께 씁니다 — kr.* 키는 한국 책, '미국 책' 표시 키는 미국 책, 표시 없는 키(모델·하루 호출 상한·정기 작업 몫 "
  + "예약·메모·단가 등)는 두 책 공용입니다. 저장하면 버전이 하나 오르고 두 책 모두 다음 작업부터 그 판을 읽습니다. 한국 규칙 계좌 영향 키는 저장 "
  + "전에 한 번 더 묻습니다.";

/** 설정 키 하나 — 이름·설명·배지, 입력, 기본값·범위, 형 오류. */
function SettingField({
  row,
  marketLabel,
  value,
  changed,
  error,
  onChange,
}: {
  row: SettingRow;
  /** 한국 화면에서 그 키를 읽는 책('한국 책'·'미국 책') — 공용 키·미국 화면은 null(표시 없음). */
  marketLabel: string | null;
  value: string;
  changed: boolean;
  error: string | null;
  onChange: (text: string) => void;
}) {
  const id = `paper-setting-${row.key}`;
  const descriptionId = row.description ? `${id}-description` : undefined;
  const meta = [
    row.missing ? "설정 행에 없음 — 기본값으로 읽음" : null,
    `기본 ${row.defaultText}`,
    row.range ? `범위 ${row.range}` : null,
    row.isDefault === false ? "기본값과 다름" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="grid gap-2 border-b border-border/50 py-3 last:border-0 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          <label htmlFor={id} className="break-all font-mono text-xs font-semibold text-bright">{row.key}</label>
          {marketLabel && (
            <span className="whitespace-nowrap rounded-sm border border-border px-1.5 py-px text-[10px] text-text-2">{marketLabel}</span>
          )}
          {row.affectsRules && (
            <span
              title={row.market === "KR"
                ? "한국 규칙 계좌(kr_rules, 동결된 대조군)의 조건을 바꾸는 키입니다 — 저장 전에 한 번 더 묻습니다."
                : "규칙 계좌(동결된 대조군)의 조건을 바꾸는 키입니다 — 저장 전에 한 번 더 묻습니다."}
              className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${RULES_BADGE}`}
            >
              {row.market === "KR" ? "한국 규칙 계좌 영향" : "규칙 계좌 영향"}
            </span>
          )}
          {changed && <span className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${CHANGED_BADGE}`}>바꿈</span>}
        </div>
        {row.description && <p id={descriptionId} className="mt-0.5 text-[11px] leading-relaxed text-muted">{row.description}</p>}
      </div>
      <div className="min-w-0">
        <SettingInput row={row} id={id} value={value} describedBy={descriptionId} onChange={onChange} />
        <p className="mt-1 text-[11px] text-muted">{meta}</p>
        {error && <p className="mt-1 text-[11px] text-warn">{error}</p>}
      </div>
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
  describedBy,
  onChange,
}: {
  row: SettingRow;
  id: string;
  value: string;
  describedBy?: string;
  onChange: (text: string) => void;
}) {
  switch (row.kind) {
    case "boolean":
      return (
        <span className="flex items-center gap-2 text-sm text-body">
          <input
            id={id}
            type="checkbox"
            checked={value === "true"}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked ? "true" : "false")}
          />
          {value === "true" ? "예" : "아니오"}
        </span>
      );
    case "choice":
      return (
        <select
          id={id}
          value={value}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT} sm:max-w-[22rem]`}
        >
          {row.options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
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
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
            className={`${INPUT} font-mono text-xs`}
          />
          <p className="text-[11px] text-muted">{MULTILINE_HINT[row.kind]}</p>
        </>
      );
    }
    case "json":
      return (
        <p className="text-xs text-muted">
          <code id={id} className="break-all text-body">{row.current}</code> — 이 화면에서 바꾸지 않는 값입니다.
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
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT} sm:max-w-[22rem]`}
        />
      );
  }
}
