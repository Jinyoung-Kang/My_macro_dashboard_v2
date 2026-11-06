"use client";

import { useCallback, useId, useState } from "react";
import { DataTable, type Column } from "@/components/patterns";
import { Banner, buttonClasses, inputClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber } from "@/lib/format";
import {
  bookStatusLabel,
  cancelBlocked,
  CONFIRM_TEXT,
  DEFAULT_SOURCE_BOOK,
  DIALOG_TITLE,
  ENABLE_WARNINGS,
  formatShares,
  formatWon,
  haltReasonLabel,
  limitRows,
  LOSS_LIMIT,
  parseLossLimit,
  PREFLIGHT_CHECKLIST,
  previewTimingText,
  realTradeErrorCode,
  realTradeErrorText,
  sideLabel,
  skippedText,
  sourceBookLabel,
  SOURCE_BOOKS,
  symbolText,
  toNumber,
  type RealTradeDialogMode,
} from "@/lib/realtrade";
import type {
  RealTradeActionResponse,
  RealTradeEnableRequest,
  RealTradeMarket,
  RealTradePreviewOrder,
  RealTradePreviewResponse,
  RealTradeResumeRequest,
  RealTradeStatusResponse,
  RealTradeUpdateRequest,
} from "@/lib/types/realtrade";

/** 예상 목록 읽기 한도 — 백엔드가 토스를 새로 읽습니다(보유·매수 가능·현재가·상한가). 실제 계좌 조회와 같은 40초. */
const PREVIEW_TIMEOUT_MS = 40_000;

/** 확인 단추 글(창 안). */
const SUBMIT_LABEL: Readonly<Record<RealTradeDialogMode, string>> = { enable: "켜기", update: "바꾸기", resume: "멈춤 해제" };

type SendArgs =
  | { mode: "enable"; body: RealTradeEnableRequest }
  | { mode: "update"; body: RealTradeUpdateRequest }
  | { mode: "resume"; body: RealTradeResumeRequest };

/** 켜기류 한 번 보내기 — 경로는 늘 endpoints.realtrade.*(경계 시험이 apiPost의 첫 인자를 봅니다). */
function post(args: SendArgs): Promise<RealTradeActionResponse> {
  switch (args.mode) {
    case "enable":
      return apiPost<RealTradeActionResponse>(endpoints.realtrade.enable, args.body);
    case "update":
      return apiPost<RealTradeActionResponse>(endpoints.realtrade.update, args.body);
    case "resume":
      return apiPost<RealTradeActionResponse>(endpoints.realtrade.resume, args.body);
  }
}

/**
 * 실제 매매 켜기·설정 바꾸기·멈춤 해제 창(ADR 0028, 명세 §8) — `Dialog` 위의 폼이고 `ConfirmDialog`의 requireText 모양을 따릅니다.
 *
 * <p>켜기: 방식 셋(기본 규칙 계좌, 책 상태 표시)·손실 한도(기본 15%)·서버 안전 상한·예상 목록(/preview)·경고·켜기 전 점검표·확인 글자·비밀번호.
 * 바꾸기: 방식·손실 한도·기준 다시 잡기 중 바꾸는 것만 보냅니다. 해제: 멈춤 사유와 예상 목록. 셋 다 확인 글자를 정확히 쳐야 단추가 열리고,
 * 친 글자를 그대로 서버로 보냅니다(서버가 다시 검사 — 화면이 정답을 대신 채우지 않음). 비밀번호는 입력칸에만 두고 성공·실패 뒤 남기지 않습니다.
 *
 * <p>창은 결과가 나온 뒤 닫힙니다(처리 중에는 Esc·바깥 누르기로 닫히지 않음). 서버 오류는 코드별 문구로 창 안에 보입니다.
 */
export function RealTradeEnableDialog({
  mode,
  status,
  market,
  onClose,
  onDone,
  onConflict,
}: {
  mode: RealTradeDialogMode | null;
  status: RealTradeStatusResponse;
  market: RealTradeMarket;
  onClose: () => void;
  onDone: (mode: RealTradeDialogMode) => void;
  onConflict: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={mode ? DIALOG_TITLE[mode] : "실제 매매"}
      description={mode ? DESCRIPTION[mode] : undefined}
      size="lg"
      placement="top"
      dismissible={!busy}
    >
      {/* 내용은 닫히면 DOM에서 빠지므로 입력(확인 글자·비밀번호)과 오류는 다시 열 때 저절로 비워집니다. */}
      {mode && (
        <RealTradeForm
          mode={mode}
          status={status}
          market={market}
          onBusyChange={setBusy}
          onCancel={onClose}
          onDone={() => onDone(mode)}
          onConflict={onConflict}
        />
      )}
    </Dialog>
  );
}

const DESCRIPTION: Readonly<Record<RealTradeDialogMode, string>> = {
  enable: "토스증권 실제 계좌의 원화 자산 전부가 고른 모의 한국 책을 따라 자동으로 사고팝니다. 끄기는 언제든 확인 없이 바로 됩니다.",
  update: "따라 하는 방식·손실 한도·기준 평가액 중 바꿀 것만 고릅니다. 방식을 바꾸면 옛 책 따라 하기를 바로 멈추고 이 기능의 미체결을 취소합니다.",
  resume: "멈춘 사유를 토스증권 앱에서 확인한 뒤 푸세요. 풀면 다음 맞추기에서 보유를 책 비중에 다시 맞춥니다.",
};

function RealTradeForm({
  mode,
  status,
  market,
  onBusyChange,
  onCancel,
  onDone,
  onConflict,
}: {
  mode: RealTradeDialogMode;
  status: RealTradeStatusResponse;
  market: RealTradeMarket;
  onBusyChange: (busy: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
  onConflict: () => void;
}) {
  const ids = useId();
  // 창을 연 때의 설정(버전·책·손실 한도)을 붙잡아 둡니다 — 창이 열린 동안 15초 상태 읽기가 다른 곳의 변경을 가져와도 조용히 따라가지 않고,
  // 서버가 버전 충돌(409)로 알리게 합니다. 충돌을 본 뒤에는 다시 읽은 상태의 버전으로 보냅니다(사용자가 문구를 보고 다시 누름).
  const [opened] = useState(() => ({
    version: typeof status.version === "number" ? status.version : null,
    book: status.sourceBook && SOURCE_BOOKS.some((entry) => entry.code === status.sourceBook) ? status.sourceBook : null,
    loss: toNumber(status.lossLimitPct),
  }));
  const [followLatest, setFollowLatest] = useState(false);
  const currentBook = opened.book;
  const currentLoss = opened.loss;
  const [book, setBook] = useState<string>(mode === "enable" ? DEFAULT_SOURCE_BOOK : (currentBook ?? DEFAULT_SOURCE_BOOK));
  const [lossText, setLossText] = useState<string>(
    mode === "update" && currentLoss !== null ? String(currentLoss) : String(LOSS_LIMIT.default),
  );
  const [rebaseline, setRebaseline] = useState(false);
  const [checked, setChecked] = useState<boolean[]>(() => PREFLIGHT_CHECKLIST.map(() => false));
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");

  const send = useCallback(
    async (args: SendArgs) => {
      try {
        return await post(args);
      } catch (error) {
        // 세션이 끝났으면 그대로 올려 로그인으로 보내게 둡니다(useAsyncAction).
        if (error instanceof UnauthorizedError) throw error;
        const code = realTradeErrorCode(error);
        // 버전 충돌(서버 코드 version-conflict, 코드 없는 409)일 때만 상태를 다시 읽어 창 밖 칸을 맞추고, 다음 시도는 다시 읽은 버전으로 보냅니다.
        // 같은 409라도 book-changed·invalid-state·not-ready는 다시 보내도 같은 답이라 따라가지 않고 그 문구를 보입니다(SEC-3).
        if (code === "version-conflict") {
          setFollowLatest(true);
          onConflict();
        }
        throw new Error(realTradeErrorText(code, args.mode, error instanceof Error ? error.message : null));
      }
    },
    [onConflict],
  );
  const action = useAsyncAction(send, "요청을 처리하지 못했습니다.");

  // 예상 목록 — 켜기·바꾸기는 고른 책, 해제는 지금 따라 하는 책. 고른 책이 바뀌면 다시 읽습니다(토스를 새로 읽음 — 자동 갱신 없음).
  const previewBook = mode === "resume" ? currentBook : book;
  const preview = useApi<RealTradePreviewResponse>(
    previewBook ? endpoints.realtrade.preview(market, previewBook) : null,
    0,
    { timeoutMs: PREVIEW_TIMEOUT_MS, followRefresh: false },
  );
  const previewOk = preview.data?.ok === true;

  const loss = mode === "resume" ? null : parseLossLimit(lossText);
  const bookStatus = status.books?.find((entry) => entry.code === book)?.status ?? null;
  const bookInactive = mode !== "resume" && bookStatus !== null && bookStatus !== "ACTIVE";
  const changes =
    mode !== "update" || book !== currentBook || (loss !== null && loss !== currentLoss) || rebaseline;
  const latestVersion = typeof status.version === "number" ? status.version : null;
  const version = followLatest ? latestVersion : opened.version;
  const required = CONFIRM_TEXT[mode];

  const blockers: string[] = [];
  if (version === null) blockers.push("설정 버전을 몰라 보낼 수 없습니다 — 창을 닫고 상태를 다시 읽으세요.");
  if (mode !== "resume" && loss === null) blockers.push(`손실 한도는 ${LOSS_LIMIT.min}~${LOSS_LIMIT.max}%(소수 둘째 자리까지)입니다.`);
  if (bookInactive) blockers.push("고른 책이 운용 중이 아닙니다 — 켜면 정기 작업이 바로 멈춥니다(book-not-active).");
  if (mode === "enable" && !previewOk) blockers.push("예상 목록을 받은 뒤에 켤 수 있습니다.");
  if (mode === "enable" && !checked.every(Boolean)) blockers.push("켜기 전 점검표를 모두 확인하세요.");
  if (!changes) blockers.push("바꿀 것이 없습니다.");

  const canSubmit = !action.busy && blockers.length === 0 && typed === required && password !== "";

  const submit = async () => {
    if (!canSubmit || version === null) return;
    // 확인 글자는 친 글자 그대로(typed) 보냅니다 — 서버가 다시 검사합니다.
    const args: SendArgs =
      mode === "enable"
        ? { mode, body: { market, sourceBook: book, lossLimitPct: loss as number, confirm: typed, password, version } }
        : mode === "update"
          ? {
              mode,
              body: {
                market,
                ...(book !== currentBook ? { sourceBook: book } : {}),
                ...(loss !== null && loss !== currentLoss ? { lossLimitPct: loss } : {}),
                ...(rebaseline ? { rebaseline: true } : {}),
                confirm: typed,
                password,
                version,
              },
            }
          : { mode, body: { market, confirm: typed, password, version } };
    onBusyChange(true);
    const ok = await action.run(args);
    onBusyChange(false);
    // 비밀번호는 성공·실패와 관계없이 남기지 않습니다(틀림·잠김·충돌 모두 다시 입력).
    setPassword("");
    if (ok) onDone();
  };

  return (
    <form
      className="mt-4 flex flex-col gap-5"
      aria-busy={action.busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {mode === "resume" && (
        <Banner tone={status.state === "HALTED" ? "danger" : "warn"}>
          {status.state === "HALTED"
            ? `멈춘 사유: ${haltReasonLabel(status.haltReason)} — ${
                cancelBlocked(status)
                  ? "매도도 멈췄지만 서버 매매 스위치가 꺼져 있어 이 기능은 미체결을 취소하지 못합니다(토스증권 앱에서 확인)."
                  : "멈춘 동안 이 기능의 미체결 취소를 보냈고 매도도 멈췄습니다."
              }`
            : "손실 한도에 걸려 새 매수를 멈췄습니다(매도는 계속 따라 하는 중). 풀면 매수도 다시 따라 합니다."}
        </Banner>
      )}

      {mode !== "resume" && (
        <fieldset className="flex flex-col gap-2" disabled={action.busy}>
          <legend className="mb-1 text-sm font-medium text-text">따라 할 방식</legend>
          <div className="flex flex-col gap-2">
            {SOURCE_BOOKS.map((option) => {
              const entry = status.books?.find((candidate) => candidate.code === option.code);
              return (
                <label key={option.code} className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="radio"
                    name={`${ids}-book`}
                    value={option.code}
                    checked={book === option.code}
                    onChange={() => setBook(option.code)}
                    className="size-4 accent-accent"
                  />
                  <span>{option.label}</span>
                  <span className="text-xs text-text-3">
                    {option.code} · {entry ? bookStatusLabel(entry.status) : "상태 모름"}
                    {option.code === currentBook ? " · 지금 따라 하는 책" : ""}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {mode !== "resume" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-loss`} className="text-sm font-medium text-text">
            손실 한도(%)
          </label>
          <input
            id={`${ids}-loss`}
            type="text"
            inputMode="decimal"
            value={lossText}
            onChange={(event) => setLossText(event.target.value)}
            disabled={action.busy}
            autoComplete="off"
            aria-describedby={`${ids}-loss-help`}
            className={`w-32 ${inputClasses()}`}
          />
          <p id={`${ids}-loss-help`} className="text-xs leading-relaxed text-text-3">
            켤 때의 원화 총액에서 기준 평가액(켤 때 운용 평가액)의 이만큼이 줄면 새 매수만 멈추고 매도는 계속 따라 합니다 — {LOSS_LIMIT.min}~{LOSS_LIMIT.max}%, 기본{" "}
            {LOSS_LIMIT.default}%.
          </p>
          {mode === "update" && (
            <label className="mt-1 flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={rebaseline}
                onChange={(event) => setRebaseline(event.target.checked)}
                disabled={action.busy}
                className="size-4 accent-accent"
              />
              기준 평가액을 지금 운용 평가액으로 다시 잡기(원화를 넣거나 뺀 뒤)
            </label>
          )}
        </div>
      )}

      <section aria-label="서버 안전 상한" className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-text">서버 안전 상한</h3>
        <p className="text-xs text-text-3">운영 서버 설정 값 — 이 화면에서 바꿀 수 없습니다. 운용 평가액 상한을 넘는 몫은 현금으로 둡니다.</p>
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {limitRows(status.limits).map((row) => (
            <div key={row.label} className="flex justify-between gap-2">
              <dt className="text-text-2">{row.label}</dt>
              <dd className="tabular-nums text-text">{row.text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <PreviewSection preview={preview} bookLabel={previewBook ? sourceBookLabel(previewBook) : null} />

      {(mode === "enable" || (mode === "update" && book !== currentBook)) && (
        <Banner tone="danger">
          <ul className="list-disc space-y-1 pl-4">
            {ENABLE_WARNINGS.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Banner>
      )}

      {mode === "enable" && (
        <fieldset className="flex flex-col gap-2" disabled={action.busy}>
          <legend className="mb-1 text-sm font-medium text-text">켜기 전 점검표</legend>
          {PREFLIGHT_CHECKLIST.map((item, index) => (
            <label key={item} className="flex items-start gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={checked[index]}
                onChange={(event) => setChecked((list) => list.map((value, at) => (at === index ? event.target.checked : value)))}
                className="mt-0.5 size-4 shrink-0 accent-accent"
              />
              {item}
            </label>
          ))}
        </fieldset>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-confirm`} className="text-sm text-text-2">
          확인하려면 다음 글자를 그대로 입력하세요: <code className="rounded-sm bg-surface-2 px-1 font-mono text-text">{required}</code>
        </label>
        <input
          id={`${ids}-confirm`}
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          disabled={action.busy}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className={`w-full ${inputClasses()}`}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-password`} className="text-sm text-text-2">
          운영자 비밀번호
        </label>
        <input
          id={`${ids}-password`}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={action.busy}
          autoComplete="off"
          className={`w-full ${inputClasses()}`}
        />
      </div>

      {blockers.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-text-3" aria-label="보내기 전에 필요한 것">
          {blockers.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}

      {action.error && (
        <div role="alert">
          <Banner tone="danger">{action.error}</Banner>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={action.busy} className={buttonClasses("secondary")}>
          취소
        </button>
        <button type="submit" disabled={!canSubmit} className={buttonClasses(mode === "resume" ? "primary" : "danger")}>
          {action.busy ? "보내는 중…" : SUBMIT_LABEL[mode]}
        </button>
      </div>
    </form>
  );
}

const PREVIEW_COLUMNS: readonly Column<RealTradePreviewOrder>[] = [
  { key: "side", header: "방향", cell: (row) => sideLabel(row.side) },
  { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name) },
  { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity) },
  { key: "estAmount", header: "예상 금액", align: "right", cell: (row) => formatWon(row.estAmount) },
];

/** 회전율(매수 + 매도 금액 ÷ 운용 평가액, %) — 모르면 "—". */
function turnoverText(value: unknown): string {
  const pct = toNumber(value);
  return pct === null ? EMPTY : `${formatNumber(pct, 1)}%`;
}

/** 예상 목록 — 지금 값으로 계산한 '팔 종목·살 종목'. 실제 주문은 다음 맞추기에서 그때 값으로 다시 계산합니다. */
function PreviewSection({
  preview,
  bookLabel,
}: {
  preview: ReturnType<typeof useApi<RealTradePreviewResponse>>;
  bookLabel: string | null;
}) {
  const { data, loading, error, reload } = preview;
  return (
    <section aria-label="예상 목록" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-text">예상 목록{bookLabel ? ` — ${bookLabel}` : ""}</h3>
      {!bookLabel && <p className="text-sm text-text-3">따라 하는 책을 몰라 예상 목록을 계산하지 않았습니다.</p>}
      {bookLabel && loading && !data && <p className="text-sm text-text-3">토스에서 지금 보유·매수 가능 금액을 읽어 계산하는 중…</p>}
      {bookLabel && (error || (data && data.ok !== true)) && (
        <Banner tone="warn">
          <p>
            예상 목록을 읽지 못했습니다{error ? ` — ${error}` : data?.reason ? ` — ${data.reason}` : ""}.
          </p>
          <button type="button" onClick={() => void reload()} disabled={loading} className={`mt-2 ${buttonClasses("secondary", "sm")}`}>
            {loading ? "읽는 중…" : "다시 계산"}
          </button>
        </Banner>
      )}
      {data?.ok === true && (
        <>
          <p className="text-xs leading-relaxed text-text-3">
            운용 평가액 {formatWon(data.equity)} · 회전율 {turnoverText(data.turnoverPct)} · 다음 맞추기 {previewTimingText(data.syncAt)} · 지금
            값으로 계산한 예상이고, 실제 주문은 다음 맞추기에서 그때 보유·가격으로 다시 계산합니다.
          </p>
          <DataTable
            caption="예상 주문"
            columns={PREVIEW_COLUMNS}
            rows={data.orders ?? []}
            rowKey={(row) => `${row.side}-${row.symbol}`}
            emptyText="보낼 주문 없음 — 이미 책 비중에 맞습니다"
          />
          {(data.skipped ?? []).length > 0 && (
            <div className="text-xs text-text-2">
              <p className="font-medium">건너뛸 종목</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {(data.skipped ?? []).map((item, index) => (
                  <li key={index}>{skippedText(item)}</li>
                ))}
              </ul>
            </div>
          )}
          {(data.warnings ?? []).length > 0 && (
            <Banner tone="warn">
              <ul className="list-disc space-y-0.5 pl-4">
                {(data.warnings ?? []).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Banner>
          )}
        </>
      )}
    </section>
  );
}
