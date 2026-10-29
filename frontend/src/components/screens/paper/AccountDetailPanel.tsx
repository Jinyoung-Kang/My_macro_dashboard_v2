"use client";

import { DonutChart, SERIES_COLORS } from "@/components/charts";
import { Banner, Button, ErrorState, Freshness, Loading, SourceLine, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { deltaColor, EMPTY, formatKst, formatNumber } from "@/lib/format";
import {
  type AccountComposition,
  accountComposition,
  accountProfile,
  accountSettingRows,
  bookCard,
  COMPOSITION_TOP_N,
  type CompositionRow,
  type CompositionSegment,
  fillBadges,
  formatSharePrice,
  PAPER_SOURCES,
  sideClass,
  sideLabel,
} from "@/lib/paper";
import { krConfirmationCells, krFillBadges } from "@/lib/paperKr";
import { marketMeta, type PaperMarketCode } from "@/lib/paperMarket";
import type {
  PaperBookSummary,
  PaperFill,
  PaperFillsResponse,
  PaperPositionsResponse,
  PaperSettingsResponse,
} from "@/lib/types";

/** 상세에 보일 최근 체결 수. 전체는 보유·체결 탭(최근 50건). */
const RECENT_FILLS = 5;

/**
 * 구성 차트 색 — 상위 종목(lib COMPOSITION_TOP_N = 3)은 순위 순서대로 charts의 검증된 세 색을 고정 배정합니다. 기타·현금은 무채색.
 *
 * dataviz 검증기(validate_palette.js)로 v2 토큰의 바탕·표면(라이트 #f7f7f5·#ffffff, 다크 #0d0d0d·#1a1a19)에서 쟀습니다: 세 색 모두 밝기 띠·채도·대비 3:1
 * 통과, 이웃 쌍뿐 아니라 모든 쌍(--pairs all)이 색약 ΔE 최소 9.4(청록↔주황)·정상 시각 최소 20.9(청록↔파랑). 넷째 색 노랑(#c98500)은
 * 주황과 모든 쌍에서 색약 4.8·정상 10.6이라 뺐습니다 — 묶음이 넷을 넘으면 직접 라벨이 없어 색으로 범례와 맞춰야 하기 때문입니다.
 * 회색 둘은 고리에서 맞닿을 수 있는 모든 쌍(기타↔청록·현금·파랑, 현금↔세 색 — 마지막 조각은 첫 조각과도 맞닿음)이 정상 시각 ΔE 15
 * 이상이고 색약 ΔE 8 이상인 단계입니다(기타↔청록 16.7·11.8로 가장 가까움). 앞서 쓰던 기타 #6e7681은 노랑을 빼자 청록 바로 뒤에 놓여
 * 14.3·7.7로 기준에 못 미쳐 한 단계 어둡게 했고, 처음 떠올린 #8b949e는 파랑과 14.9, 청록과 13.5로 쓰지 않습니다.
 * 회색은 범주 색이 아니라 채도·밝기 띠 검사는 적용하지 않습니다(현금 #9ea7b3은 다크 띠 위 0.725 — 띠 안의 회색 둘로는 세 색·서로와의
 * 구분을 함께 지킬 수 없음을 확인). 라이트에서 현금은 바탕 대비 2.3:1이라 범례·표가 같은 값을 함께 나릅니다.
 */
const SLOT_COLORS = [SERIES_COLORS.blue, SERIES_COLORS.orange, SERIES_COLORS.green];
const OTHER_COLOR = "#606870";
const CASH_COLOR = "#9ea7b3";
/** 패널 바탕(bg-canvas = 토큰 bg) — 도넛 조각 사이 2px 틈의 색이라 바탕과 같아야 틈으로 보입니다(라이트·다크를 따라 바뀜). */
const PANEL_SURFACE = "var(--bg)";

function segmentColor(segment: Pick<CompositionSegment, "kind" | "slot">): string {
  if (segment.kind === "other") return OTHER_COLOR;
  if (segment.kind === "cash") return CASH_COLOR;
  return SLOT_COLORS[segment.slot ?? 0] ?? OTHER_COLOR;
}

/** 상세 패널 제목의 id — 패널을 열면 개요가 초점을 이 제목으로 옮깁니다(OverviewSection). */
export const accountDetailTitleId = (id: string) => `${id}-title`;

/**
 * 계좌 상세 — 개요의 계좌 카드를 누르면 카드 묶음 바로 아래에 열립니다(한 번에 하나).
 *
 * 머리(이름·상태·한 줄 소개) → 정의(운용 방식·매수·매도·리스크·현금·시작·비교 목적, lib ACCOUNT_PROFILES)와 지금 설정 값(설정 응답 —
 * 문장에 숫자를 박지 않음) → 핵심 숫자 → 구성(도넛 또는 한 줄 막대 + 범례 + 표) → 최근 체결 다섯 건과 다른 탭으로 가는 단추.
 *
 * 보유·체결은 이미 있는 계좌별 응답(positions·fills)을 그대로 읽습니다 — 숫자는 장부 값이고, 묶음·비중 표기는 lib가 만듭니다(ADR 0004).
 * 보유 응답의 계좌 요약이 개요보다 새것이면(버튼 뒤 다시 읽음) 그것을 씁니다.
 *
 * 한국 계좌(`market` "KR")는 돈을 원 단위 정수, 주당 가격을 0자리로 적고 현금성 종목은 153130입니다(lib/paperMarket). 한국 최근 체결은 보유·체결 탭과
 * 같이 '잠정 체결가'(토스)·확정 상태 배지(lib/paperKr krFillBadges)이고, 확정 조정 행이 있으면 확정가를 그 아래에 둡니다.
 */
export function AccountDetailPanel({
  id,
  book,
  books,
  onClose,
  onOpenTab,
  market = "US",
}: {
  id: string;
  book: PaperBookSummary;
  books: readonly PaperBookSummary[];
  onClose: () => void;
  onOpenTab?: (tab: "holdings" | "decisions", code: string) => void;
  /** 이 계좌의 시장(기본 미국). */
  market?: PaperMarketCode;
}) {
  const meta = marketMeta(market);
  const korea = market === "KR";
  const positions = useApi<PaperPositionsResponse>(endpoints.paper.positions(book.code), 60_000);
  const fills = useApi<PaperFillsResponse>(endpoints.paper.fills(book.code, RECENT_FILLS), 60_000);
  // 설정은 자주 바뀌지 않아 열 때 한 번만 읽습니다. 못 읽으면 정의 문장만 보입니다(숫자를 지어내지 않음).
  const settings = useApi<PaperSettingsResponse>(endpoints.paper.settings);

  const current = positions.data?.available && positions.data.book ? positions.data.book : book;
  const card = bookCard(current, books, market);
  const profile = accountProfile(book.code);
  const settingRows = accountSettingRows(book.code, settings.data?.available ? settings.data.body : null);
  const composition = positions.data?.available
    ? accountComposition(positions.data.positions ?? [], positions.data.cash ?? null, current.nav, market)
    : null;
  const decides = book.kind === "RULES" || book.kind === "CLAUDE";
  const titleId = accountDetailTitleId(id);

  return (
    <section
      id={id}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="mt-4 flex flex-col gap-5 rounded-lg border border-accent/40 bg-canvas px-4 py-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {/* 열 때 초점을 받는 자리(tabIndex -1 — Tab 순서에는 넣지 않음). 단추가 아니라 초점 테두리는 그리지 않습니다. */}
            <h3 id={titleId} tabIndex={-1} className="text-base font-semibold text-bright focus:outline-hidden">{book.label} 상세</h3>
            <span className={`rounded-sm border px-2 py-0.5 text-[11px] ${card.status.className}`}>{card.status.label}</span>
          </div>
          {profile && <p className="mt-1 text-xs text-body">{profile.summary}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Freshness refreshError={positions.refreshError ?? fills.refreshError} />
          <Button onClick={onClose}>닫기</Button>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-label="정의" className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold text-bright">정의</h4>
          {profile ? (
            <dl className="flex flex-col gap-2 text-xs leading-relaxed">
              {profile.definitions.map((definition) => (
                <div key={definition.key} className="grid gap-x-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
                  <dt className="font-semibold text-muted">{definition.label}</dt>
                  <dd className="text-body">{definition.text}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs text-muted">이 계좌({book.code})의 정의가 화면에 없습니다 — 장부 숫자만 보입니다.</p>
          )}
          {settingRows.length > 0 && (
            <div className="mt-2 border-t border-border pt-2">
              <h4 className="text-xs font-semibold text-bright">지금 설정</h4>
              <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                {settingRows.map((row) => (
                  <div key={row.key} className="flex min-w-0 items-baseline justify-between gap-2">
                    <dt className="text-muted" title={row.key}>{row.label}</dt>
                    <dd className="text-right tabular-nums text-body">{row.value}</dd>
                  </div>
                ))}
              </dl>
              <SourceLine>{PAPER_SOURCES.settings} — 바꾸려면 설정 탭</SourceLine>
            </div>
          )}
        </section>

        <section aria-label="핵심 숫자" className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold text-bright">핵심 숫자</h4>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Tile label="순자산" value={card.nav} />
            <Tile label="수익률(출발 이후)" value={card.returnPct} tone={deltaColor(current.returnPct)} />
            <Tile label="현금" value={card.cash} />
            {/* 장부의 주식 노출은 평가액 ÷ 순자산이라 현금성(SHY)도 들어갑니다 — 구성 차트의 '현금·현금성'과 같은 SHY를 두 번 읽지 않게 적습니다. */}
            <Tile label="주식 노출" value={card.exposure} caption={`현금성(${meta.cashLike}) 포함`} />
            <Tile label="보유 종목 수" value={card.positions} />
            <Tile label="출발일" value={card.startedOn} />
            <Tile label="마지막 평가" value={card.lastObserved} />
          </dl>
          {card.staleWarning && <p className="text-[11px] text-warn">{card.staleWarning}</p>}
          <SourceLine>{korea ? PAPER_SOURCES.krLedger : PAPER_SOURCES.ledger}</SourceLine>
        </section>
      </div>

      <section aria-label="구성" className="flex flex-col gap-3 border-t border-border pt-4">
        <div>
          <h4 className="text-xs font-semibold text-bright">구성 — 순자산 대비 비중</h4>
          <p className="mt-0.5 text-[11px] text-muted">
            상위 {COMPOSITION_TOP_N}종목은 따로, 나머지 종목은 &quot;기타&quot;(하나뿐이면 그 종목 이름), 현금과 현금성 종목({meta.cashLike} 등 — 설정
            {korea ? "kr.cashLikeTickers" : "cashLikeTickers"})은 한 묶음입니다. 비중은 장부의 평가액 ÷ 순자산입니다.
          </p>
        </div>
        {positions.loading && !positions.data && <Loading label="보유를 읽는 중…" />}
        {positions.error && <ErrorState message={positions.error} onRetry={positions.reload} />}
        {positions.data && !positions.data.available && <Banner tone="warn">{positions.data.message}</Banner>}
        {composition && <CompositionView label={book.label} composition={composition} />}
      </section>

      <section aria-label="최근 체결" className="flex flex-col gap-2 border-t border-border pt-4">
        <h4 className="text-xs font-semibold text-bright">최근 체결 ({RECENT_FILLS}건)</h4>
        {fills.loading && !fills.data && <Loading label="체결을 읽는 중…" />}
        {fills.error && <ErrorState message={fills.error} onRetry={fills.reload} />}
        {fills.data && !fills.data.available && <Banner tone="warn">{fills.data.message}</Banner>}
        {fills.data?.available && (
          <Table<PaperFill>
            label="최근 체결"
            rows={fills.data.fills ?? []}
            rowKey={(row) => String(row.id)}
            emptyMessage="체결이 없습니다."
            columns={[
              { key: "observedAt", header: "관측 시각", render: (row) => formatKst(row.observedAtKst) },
              {
                key: "ticker",
                header: "종목",
                render: (row) => (
                  <span className="flex flex-wrap items-center gap-1">
                    <span>{row.ticker}</span>
                    {(korea ? krFillBadges(row) : fillBadges(row)).map((badge) => (
                      <span key={badge.key} title={badge.title} className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${badge.className}`}>
                        {badge.label}
                      </span>
                    ))}
                  </span>
                ),
              },
              { key: "side", header: "방향", render: (row) => <span className={sideClass(row.side)}>{sideLabel(row.side)}</span> },
              { key: "qty", header: "수량", align: "right", render: (row) => formatNumber(row.qty, 0) },
              {
                key: "price",
                // 한국 체결 행의 가격은 토스 잠정가입니다 — 확정가는 확정 조정 행에(보유·체결 탭과 같은 머리).
                header: korea ? `잠정 체결가(${meta.unitLabel})` : `체결가(${meta.unitLabel})`,
                align: "right",
                render: (row) => {
                  const price = formatSharePrice(row.price, market);
                  const confirmed = korea ? krConfirmationCells(row).price : null;
                  return confirmed && confirmed !== EMPTY ? (
                    <span className="flex flex-col items-end">
                      <span>{price}</span>
                      <span className="whitespace-nowrap text-[11px] text-text-3">{`확정 ${confirmed}`}</span>
                    </span>
                  ) : price;
                },
              },
              {
                key: "gross",
                header: korea ? `잠정 금액(${meta.unitLabel})` : `금액(${meta.unitLabel})`,
                align: "right",
                // 한국은 원 단위 정수, 미국은 예전처럼 소수 2자리(단위는 머리에).
                render: (row) => formatNumber(row.gross, meta.moneyDigits),
              },
            ]}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {onOpenTab && (
            <Button onClick={() => onOpenTab("holdings", book.code)}>보유·체결 탭에서 전체 보기</Button>
          )}
          {onOpenTab && decides && <Button onClick={() => onOpenTab("decisions", book.code)}>결정 로그 보기</Button>}
        </div>
      </section>
    </section>
  );
}

/** 구성 — 도넛(묶음 셋 이상) 또는 한 줄 막대(둘 이하), 범례, 표. 그리지 못하면 이유와 표만. */
function CompositionView({ label, composition }: { label: string; composition: AccountComposition }) {
  const { form, segments, rows, note } = composition;
  const colorOf = new Map(segments.map((segment) => [segment.key, segmentColor(segment)]));
  const summary = segments.map((segment) => `${segment.label} ${segment.shareText}`).join(", ");
  return (
    <>
      {note && <p className="text-xs text-muted">{note}</p>}
      {form === "donut" && (
        <div className="grid items-center gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <DonutChart
            ariaLabel={`${label} 구성 도넛: ${summary}`}
            surface={PANEL_SURFACE}
            segments={segments.map((segment) => ({
              key: segment.key,
              name: segment.label,
              value: segment.sharePct,
              color: segmentColor(segment),
              valueText: segment.shareText,
              caption: `평가액 ${segment.valueText}`,
              detail: segment.detail,
              label: segment.directLabel,
            }))}
          />
          <Legend segments={segments} />
        </div>
      )}
      {form === "meter" && (
        <div className="flex flex-col gap-2">
          {/* 묶음이 둘 이하면 도넛 대신 한 줄 막대 — 두 조각 파이는 숫자보다 읽기 어렵습니다. 조각 사이 2px 틈은 바탕색. */}
          <div role="img" aria-label={`${label} 구성: ${summary}`} className="flex h-3 w-full gap-[2px] overflow-hidden rounded-sm">
            {segments.map((segment) => (
              <div
                key={segment.key}
                title={`${segment.label} ${segment.shareText} · 평가액 ${segment.valueText}`}
                className="h-full"
                style={{ flexGrow: segment.sharePct, flexBasis: 0, backgroundColor: segmentColor(segment) }}
              />
            ))}
          </div>
          <Legend segments={segments} />
        </div>
      )}
      <Table<CompositionRow>
        label="구성"
        rows={rows}
        rowKey={(row) => row.key}
        emptyMessage="보유가 없습니다."
        columns={[
          {
            key: "label",
            header: "종목",
            render: (row) => (
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: colorOf.get(row.segmentKey) ?? "transparent" }}
                />
                <span className={row.isCash ? "text-body" : "font-semibold text-bright"}>{row.label}</span>
                {row.cashLike && (
                  <span title="현금성 ETF — 트레일링 스탑을 적용하지 않습니다." className="rounded-sm border border-border bg-surface-hover px-1.5 py-px text-[10px] text-muted">
                    현금성
                  </span>
                )}
              </span>
            ),
          },
          { key: "share", header: "비중", align: "right", render: (row) => row.shareText },
          { key: "value", header: "평가액", align: "right", render: (row) => row.valueText },
          {
            key: "unrealized",
            header: "수익률(평단 대비)",
            align: "right",
            render: (row) => <span className={deltaColor(row.unrealizedPct)}>{row.unrealizedText}</span>,
          },
          { key: "qty", header: "수량", align: "right", render: (row) => row.qtyText },
        ]}
      />
    </>
  );
}

/** 범례 — 늘 보입니다(색만으로 묶음을 가리지 않게). 이름·내역은 본문 글자색, 색은 옆의 네모가 나릅니다. */
function Legend({ segments }: { segments: readonly CompositionSegment[] }) {
  return (
    <ul aria-label="구성 범례" className="flex w-full max-w-md flex-col gap-1.5 text-xs">
      {segments.map((segment) => (
        <li key={segment.key} className="flex items-start gap-2">
          <span
            aria-hidden
            className="mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
            style={{ backgroundColor: segmentColor(segment) }}
          />
          <span className="min-w-0 flex-1 text-body">
            {segment.label}
            {segment.detail && <span className="block text-[11px] text-muted">{segment.detail}</span>}
          </span>
          <span className="tabular-nums font-semibold text-bright">{segment.shareText}</span>
        </li>
      ))}
    </ul>
  );
}

/** 핵심 숫자 한 칸 — 따로 선 큰 숫자라 자리 고정 숫자(tabular-nums)를 쓰지 않습니다. */
function Tile({ label, value, tone, caption }: { label: string; value: string; tone?: string; caption?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className={`text-sm font-semibold ${tone ?? "text-bright"}`}>{value}</dd>
      {caption && <dd className="text-[10px] text-muted">{caption}</dd>}
    </div>
  );
}
