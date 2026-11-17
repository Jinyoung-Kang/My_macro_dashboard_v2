"use client";

import { type FormEvent, type ReactElement, type RefObject, useEffect, useId, useRef, useState } from "react";
import { Skeleton } from "@/components/patterns";
import { buttonClasses, Callout, ErrorState, FOCUS_RING, inputClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useApi } from "@/hooks/useApi";
import { kindText, SYMBOL_QUERY_MAX, symbolQuery } from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import { tickerNoteWarning, tickerProxyWarning } from "@/lib/holdings";
import type { DetailSymbol, DetailSymbolsResponse } from "@/lib/types";
import { StockQuickBody } from "./StockQuickView";

/**
 * 티커 없는 13F 보유 줄의 종목 팝업 창(사용자 요청·결정 2026-11-18 '후보 고르기'). 13F 공시에는 티커가 없고 수집기의 이름 매핑표에 없는 이름은
 * 티커가 비어 있어, 같은 창에서 공시 이름으로 종목 후보를 찾고(GET /api/detail/symbols — 통합 검색과 같은 Yahoo·네이버 자동완성) 사용자가 하나를
 * 고르면 그 종목의 시세 본문({@link StockQuickBody})을 보입니다. <b>첫 후보를 자동으로 고르지 않습니다</b> — 이름이 비슷한 다른 종목의 주가가 그 보유의
 * 값처럼 보이면 안 됩니다. 수집기가 일부러 티커를 뺀 줄(채권·보통주 아닌 증권 — tickerNote)은 고른 종목의 주가와 값이 다르다고, 수집기 티커가 같은
 * 회사의 다른 클래스일 수 있는 줄(proxyTicker — 백엔드 tickerIsProxy)은 그 티커를 바로 열지 않는 까닭을 경고합니다.
 * 열려 있을 때만 후보를 찾고, 고른 종목의 시세·실시간 연결도 그 본문이 보이는 동안만입니다(닫거나 '후보 다시 고르기'면 닫힘).
 */
export function StockPickQuickView({
  name,
  cusip,
  cls,
  tickerNote,
  proxyTicker,
  trigger,
}: {
  /** 13F 공시 이름(nameOfIssuer) — 창 제목이자 처음 검색어. */
  name: string;
  cusip?: string | null;
  cls?: string | null;
  /** 수집기가 일부러 티커를 붙이지 않은 까닭(debt·non_common). 없으면 null. */
  tickerNote?: string | null;
  /** 같은 회사의 다른 클래스일 수 있어 바로 열지 않은 수집기 티커(백엔드 tickerIsProxy). 없으면 null. */
  proxyTicker?: string | null;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const title = name.trim();
  const warnings = [
    proxyTicker?.trim() ? tickerProxyWarning(proxyTicker, cls) : null,
    tickerNoteWarning(tickerNote),
  ].filter((text): text is string => text !== null);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      // 13F 공시 이름은 영문 대문자 — 화면 글(한국어)과 다른 언어로 읽히게 합니다. 이름이 없으면 한국어 대신 글.
      title={title || "이름 없는 보유"}
      titleLang={title ? "en" : undefined}
      description={`CUSIP ${cusip?.trim() || EMPTY} · ${cls?.trim() || EMPTY}`}
      trigger={trigger}
      size="lg"
    >
      {open && <PickBody name={title} warnings={warnings} />}
    </Dialog>
  );
}

/** 후보 단추를 가리키는 표지 — '후보 다시 고르기' 뒤에 고른 후보로 포커스를 돌려줄 때 찾습니다. */
const symbolKey = (symbol: Pick<DetailSymbol, "market" | "code">) => `${symbol.market}:${symbol.code}`;

function PickBody({ name, warnings }: { name: string; warnings: string[] }) {
  const initial = symbolQuery(name);
  const [draft, setDraft] = useState(initial ?? "");
  const [query, setQuery] = useState<string | null>(initial);
  const [picked, setPicked] = useState<DetailSymbol | null>(null);
  const symbols = useApi<DetailSymbolsResponse>(query ? endpoints.detail.symbols(query) : null);
  const inputId = useId();
  const listLabelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  // 본문이 바뀐 뒤 포커스를 둘 곳 — 누른 단추가 사라지므로(후보 → 시세, 시세 → 후보) 포커스가 문서 처음으로 떨어지지 않게 옮겨 둡니다.
  const focusNext = useRef<{ to: "back" } | { to: "candidate"; key: string } | null>(null);

  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (!next) return;
    if (next.to === "back") {
      backRef.current?.focus();
      return;
    }
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-symbol]") ?? []);
    (buttons.find((button) => button.dataset.symbol === next.key) ?? inputRef.current)?.focus();
  }, [picked]);

  const pick = (symbol: DetailSymbol) => {
    focusNext.current = { to: "back" };
    setPicked(symbol);
  };
  const back = () => {
    focusNext.current = picked ? { to: "candidate", key: symbolKey(picked) } : null;
    setPicked(null);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = symbolQuery(draft);
    // 같은 검색어로 다시 누르면 다시 찾습니다(경로가 같아 훅이 스스로 읽지 않음).
    if (next !== null && next === query) symbols.reload();
    setQuery(next);
  };

  return (
    <div className="mt-4 flex min-w-0 flex-col gap-4">
      {warnings.map((text) => (
        <Callout key={text} tone="warn">
          {text}
        </Callout>
      ))}
      {picked ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 text-xs text-text-2">공시 이름으로 찾은 후보에서 고른 종목입니다 — 이 13F 보유와 같은 증권인지 확인하세요.</p>
            <button ref={backRef} type="button" onClick={back} className={buttonClasses("default", "sm")}>
              후보 다시 고르기
            </button>
          </div>
          <StockQuickBody market={picked.market} code={picked.code} />
        </>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-text-2">
            13F 공시에는 티커가 없어 공시 이름으로 찾은 후보입니다 — 맞는 종목을 고르세요. 자동으로 고르지 않습니다.
          </p>
          <form role="search" aria-label="종목 후보 찾기" onSubmit={submit} className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-xs text-text-2">
              검색어({SYMBOL_QUERY_MAX}자 이내 — 고쳐서 다시 찾을 수 있습니다)
            </label>
            <div className="flex min-w-0 gap-2">
              <input
                ref={inputRef}
                id={inputId}
                type="text"
                enterKeyHint="search"
                autoComplete="off"
                spellCheck={false}
                maxLength={SYMBOL_QUERY_MAX}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className={`${inputClasses()} min-w-0 flex-1`}
              />
              <button type="submit" className={buttonClasses("default")}>
                찾기
              </button>
            </div>
          </form>
          <Candidates
            query={query}
            state={symbols}
            listRef={listRef}
            listLabelId={listLabelId}
            onPick={pick}
          />
        </>
      )}
    </div>
  );
}

/** 후보 목록과 그 상태 — 검색어 없음·읽는 중·읽기 실패·종목 찾기를 쓸 수 없음·출처 실패·맞는 후보 없음은 각각 그 사실만 적습니다(없는 후보를 만들지 않음). */
function Candidates({
  query,
  state,
  listRef,
  listLabelId,
  onPick,
}: {
  query: string | null;
  state: { data: DetailSymbolsResponse | null; error: string | null; reload: () => void };
  listRef: RefObject<HTMLUListElement | null>;
  listLabelId: string;
  onPick: (symbol: DetailSymbol) => void;
}) {
  if (!query) return <p className="text-sm text-text-2">검색어를 넣고 찾기를 누르세요.</p>;
  if (state.error) return <ErrorState message={`후보를 불러오지 못했습니다 — ${state.error}`} onRetry={state.reload} />;
  const data = state.data;
  if (!data) return <Skeleton lines={3} label="후보를 찾는 중" />;
  if (!data.available) {
    return <Retry text={`종목 찾기를 쓸 수 없습니다 — ${data.message || "수집기에서 응답을 받지 못했습니다."}`} onRetry={state.reload} />;
  }
  const items = data.symbols?.items ?? [];
  const failed = Object.keys(data.symbols?.errors ?? {});
  if (items.length === 0) {
    if (data.symbols?.error || failed.length > 0) {
      return (
        <Retry
          text={`출처를 받지 못해 후보를 보이지 못했습니다${failed.length > 0 ? `(${failed.join("·")})` : ""} — 맞는 종목이 없다는 뜻은 아닙니다.`}
          onRetry={state.reload}
        />
      );
    }
    return <p className="text-sm text-text-2">‘{query}’에 맞는 종목 후보가 없습니다 — 검색어를 줄이거나 고쳐 다시 찾아 보세요.</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p id={listLabelId} className="text-xs text-text-2">
        종목 후보 {items.length}건 — 누르면 이 창에서 그 종목의 시세를 봅니다
      </p>
      {failed.length > 0 ? (
        <p className="text-xs text-text-2">일부 출처를 받지 못했습니다({failed.join("·")}) — 후보가 더 있을 수 있습니다.</p>
      ) : null}
      <ul ref={listRef} aria-labelledby={listLabelId} className="flex min-w-0 flex-col divide-y divide-border rounded-control border border-border">
        {items.map((symbol) => (
          <li key={symbolKey(symbol)}>
            <button
              type="button"
              data-symbol={symbolKey(symbol)}
              onClick={() => onPick(symbol)}
              // 덮개(대화상자) 안 누르는 칸의 hover 바탕은 surface-3 — 그 위 글자는 text·text-2만(Dialog 주석의 금지 쌍).
              className={`flex min-h-11 w-full min-w-0 flex-col items-start justify-center gap-0.5 rounded-control px-3 py-1.5 text-left hover:bg-surface-3 motion-safe:transition-colors lg:min-h-0 ${FOCUS_RING}`}
            >
              <span className="min-w-0 break-keep wrap-anywhere text-sm text-text">{symbol.name}</span>
              {/* 단추 이름에서 이름과 보조 줄이 붙지 않게 — 세로 flex 안의 빈칸 글은 그려지지 않습니다. */}{" "}
              <span className="text-xs text-text-2">
                {[symbol.code, symbol.exchange, kindText(symbol.kind), symbol.source].filter(Boolean).join(" · ")}
              </span>
              {" "}
              <span className="sr-only">시세 보기</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 사유 한 줄과 다시 시도 단추. */
function Retry({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-text-2">{text}</p>
      <button type="button" onClick={onRetry} className={buttonClasses("default", "sm")}>
        다시 시도
      </button>
    </div>
  );
}
