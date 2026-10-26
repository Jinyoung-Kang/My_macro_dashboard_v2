"use client";

import { useState } from "react";
import { Banner, Button, Card, ErrorState, Loading, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import {
  PAPER_SOURCES,
  type SettingRow,
  settingGroups,
  type SettingsHistoryRow,
  settingsConfirmText,
  settingsDraftView,
  settingsHistoryRows,
  settingsPatch,
  settingsSaveResultView,
} from "@/lib/paper";
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
 * 규칙 책 영향 키(서버 keys[].affectsRules)를 바꾸면 저장 전에 경고와 함께 한 번 더 묻고, 저장한 뒤에는 서버 warning을 그대로 보입니다(S3).
 *
 * 입력 중에는 설정을 자동으로 다시 읽지 않습니다 — 저장이 성공하면 설정과 이력을 다시 읽고 입력을 비웁니다.
 */
export function SettingsSection() {
  const settings = useApi<PaperSettingsResponse>(endpoints.paper.settings);
  const history = useApi<PaperSettingsHistoryResponse>(endpoints.paper.settingsHistory);
  // 손댄 키만 담습니다(키 → 입력 글자). 손대지 않은 키는 지금 값을 그대로 보입니다.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const save = useAsyncAction(
    (patch: Record<string, unknown>) => apiPost<PaperSettingsSaveResult>(endpoints.paper.saveSettings, patch),
    "설정을 저장하지 못했습니다.",
  );

  if (settings.loading && !settings.data) return <Loading label="설정을 읽는 중…" />;
  if (settings.error) return <ErrorState message={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return null;
  if (!settings.data.available) {
    return <Banner tone="warn">{settings.data.message ?? "설정을 읽을 수 없습니다."}</Banner>;
  }

  const data = settings.data;
  const groups = settingGroups(data);
  const { changes, errors } = settingsDraftView(groups, draft);
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
    setConfirming(false);
    if (ok) {
      setDraft({});
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
      <Card
        title="설정"
        subtitle={typeof data.version === "number"
          ? `지금 설정 v${data.version} — 바꾸면 버전이 하나 오르고, 재기동 없이 다음 작업부터 씁니다.`
          : "설정 행이 아직 없습니다(초기화 전) — 아래 값은 기본값입니다. 개요 탭에서 초기화하면 v1이 생깁니다."}
        source={PAPER_SOURCES.settings}
      >
        <p className="text-xs leading-relaxed text-muted">
          형·범위는 저장할 때 서버가 검사합니다. <span className={`rounded-sm border px-1 ${RULES_BADGE}`}>규칙 계좌 영향</span>이 붙은
          키는 규칙 계좌(동결된 대조군)의 조건을 바꿉니다 — 저장 전에 한 번 더 묻습니다. 결정 기록마다 그때의 설정 버전이 남습니다.
          계좌 일시정지·재개는 보유·체결 탭에서 합니다.
        </p>

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
                  {change.affectsRules && <span className={`rounded-sm border px-1 text-[10px] ${RULES_BADGE}`}>규칙 계좌 영향</span>}
                </li>
              ))}
            </ul>
          )}
          {errorCount > 0 && (
            <p className="text-xs text-warn">형으로 읽지 못한 값이 {errorCount}개 있습니다 — 그 키 아래 문구를 보고 고친 뒤 저장하세요.</p>
          )}

          {confirming && confirmText ? (
            <div className="flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
              <p className="text-sm leading-relaxed text-warn">{confirmText}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => void submit()} disabled={save.busy}>
                  {save.busy ? "저장 중…" : "저장 확인"}
                </Button>
                <Button onClick={() => setConfirming(false)} disabled={save.busy}>취소</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={onSave} disabled={!canSave}>
                {save.busy ? "저장 중…" : "설정 저장"}
              </Button>
              <Button onClick={() => setDraft({})} disabled={save.busy || Object.keys(draft).length === 0}>
                바꾼 값 되돌리기
              </Button>
            </div>
          )}

          {/* 서버의 400 문구(모르는 키·형·범위 밖)를 그대로 — 어느 키가 왜 틀렸는지 서버가 적어 보냅니다. */}
          {save.error && <Banner tone="warn">{save.error}</Banner>}
          {result && <Banner tone={result.tone}>{result.text}</Banner>}
          {result?.warning && <Banner tone="warn">{result.warning}</Banner>}
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

/** 설정 키 하나 — 이름·설명·배지, 입력, 기본값·범위, 형 오류. */
function SettingField({
  row,
  value,
  changed,
  error,
  onChange,
}: {
  row: SettingRow;
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
          {row.affectsRules && (
            <span
              title="규칙 계좌(동결된 대조군)의 조건을 바꾸는 키입니다 — 저장 전에 한 번 더 묻습니다."
              className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${RULES_BADGE}`}
            >
              규칙 계좌 영향
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

/**
 * 키의 형에 맞는 입력 — 숫자는 글자 상자(숫자 상자는 "abc"를 빈 값으로 바꿔 무엇이 틀렸는지 보이지 않음), 참·거짓은 체크 상자,
 * 선택지가 있으면 선택 상자, 목록은 여러 줄 상자(쉼표·공백으로 나눔). 형을 모르는 값은 바꾸지 않고 원문만 보입니다.
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
      return (
        <>
          <textarea
            id={id}
            value={value}
            rows={value.length > 80 ? 4 : value.length > 40 ? 2 : 1}
            spellCheck={false}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
            className={`${INPUT} font-mono text-xs`}
          />
          <p className="text-[11px] text-muted">
            {row.kind === "phrases" ? "쉼표·줄바꿈으로 나눕니다(항목 안의 공백은 그대로 — 예: rate decision)." : "쉼표·공백으로 나눕니다."}
          </p>
        </>
      );
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
