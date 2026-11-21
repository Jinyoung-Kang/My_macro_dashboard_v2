"use client";

import Link from "@/components/ui/IntentLink";
import { ChangeChip, InspectorSubheading, PropertyList, type PropertyItem } from "@/components/patterns";
import { LINK_CLASSES, Tag } from "@/components/ui";
import { ExternalLinkIcon } from "@/components/ui/icons";
import { streakText } from "@/lib/flows";
import { ratioText } from "@/lib/radar";
import { formatNumber, formatShares, formatSignedMinus, withMinusSign } from "@/lib/format";
import type { FlowWindow, KrFundamentalsCompany, RadarConsensusRow, RadarRow, StockFlowsResponse } from "@/lib/types";
import type { ConsensusRead } from "./ConsensusPanel";
import type { StockFlowsRead } from "./FlowPanels";
import type { FundamentalsRead } from "./FundamentalsPanel";

type StockFlow = StockFlowsResponse["stocks"][number];

/** 부호 있는 금액(순매수 — 오른·내린 값이 아님)은 본문 잉크 + 부호(음수는 −, U+2212). 모르면 null('—'). */
export function signedAmount(value: number | null | undefined, digits: number): string | null {
  return value === null || value === undefined || Number.isNaN(value) ? null : formatSignedMinus(value, digits).text;
}

/** 누적 주식 수(본문 잉크, 음수 −) + 기록이 모자라면 '(n일)'. 모르면 null. */
function windowShares(value: FlowWindow | undefined): string | null {
  if (!value || value.sum === null) return null;
  const text = withMinusSign(formatShares(value.sum));
  return value.days < value.window ? `${text} (${value.days}일)` : text;
}


/** 검사 칸의 절 — 절 머리(검사 칸 제목 바로 아래 단계 — 옆 칸 h4·대화상자 h3) + 속성 목록. */
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <InspectorSubheading fallback="h4" className="mb-1 text-caption font-semibold text-text-2">
        {title}
      </InspectorSubheading>
      {children}
    </div>
  );
}

/**
 * 이미 읽은 응답이 아직 오지 않았거나 실패했으면 그 사실(새로 읽지 않음), 왔으면 null. `object`는 목적격 조사까지 붙인 이름('수급 지속성을'·'재무를') —
 * 받침에 따라 을/를이 갈려 부르는 쪽이 붙입니다(QA-865 — 예전 `${label}를`은 '수급 지속성를'·'공통 목록를').
 */
function readState(read: { data: unknown; loading: boolean; error: string | null }, object: string): string | null {
  if (read.data) return null;
  if (read.error) return `${object} 받지 못했습니다(아래 패널의 오류 참고).`;
  return read.loading ? `${object} 불러오는 중입니다.` : `${object} 받지 못했습니다.`;
}

function flowItems(stock: StockFlow): PropertyItem[] {
  const investor = (key: string) => stock.investors?.find((row) => row.key === key);
  const pension = stock.breakdown?.find((row) => row.key === "pensionFund");
  const holding = stock.foreignerHolding;
  return [
    { label: "외국인 5일", value: windowShares(investor("foreigner")?.net5) },
    { label: "외국인 20일", value: windowShares(investor("foreigner")?.net20) },
    { label: "외국인 연속", value: streakText(investor("foreigner")?.streak, stock.records) },
    { label: "기관 20일", value: windowShares(investor("institution")?.net20) },
    { label: "기관 연속", value: streakText(investor("institution")?.streak, stock.records) },
    { label: "연기금 20일", value: windowShares(pension?.net20) },
    {
      label: "외국인 보유율",
      value: holding ? `${formatNumber(holding.ratePct, 2)}%` : null,
      // 보유율의 변화는 오르내린 값이라 공용 변화 칩(▲▼ + 부호 + 글).
      note:
        holding && holding.changePp !== null ? (
          <span className="inline-flex flex-wrap items-baseline gap-x-1">
            <ChangeChip size="sm" change={holding.changePp} digits={2} unit="%p" />
            {holding.fromDate ? <span>{holding.fromDate} 대비</span> : null}
          </span>
        ) : null,
    },
  ];
}

function fundamentalsItems(company: KrFundamentalsCompany): PropertyItem[] {
  return [
    {
      label: "부채비율",
      value: company.capitalImpaired ? <Tag tone="warn">자본잠식</Tag> : ratioText(company.debtRatio, "%"),
    },
    {
      label: "매출 증가",
      value: company.revenueGrowth === null || company.revenueGrowth === undefined ? null : <ChangeChip size="sm" changePct={company.revenueGrowth} pctDigits={1} />,
    },
    {
      label: "영업이익 증가",
      value: company.operatingTurn
        ? company.operatingTurn
        : company.operatingIncomeGrowth === null || company.operatingIncomeGrowth === undefined
          ? null
          : <ChangeChip size="sm" changePct={company.operatingIncomeGrowth} pctDigits={1} />,
    },
    { label: "ROE", value: ratioText(company.roe, "%") },
    { label: "PER", value: ratioText(company.per, "배") },
    { label: "PBR", value: ratioText(company.pbr, "배") },
  ];
}

function consensusItems(row: RadarConsensusRow): PropertyItem[] {
  return [
    { label: "외국인", value: signedAmount(row.foreignEok, 1), unit: "억 원", note: row.foreignRank === null ? null : `${row.foreignRank}위` },
    { label: "기관", value: signedAmount(row.institutionEok, 1), unit: "억 원", note: row.institutionRank === null ? null : `${row.institutionRank}위` },
    { label: "합산", value: signedAmount(row.totalEok, 1), unit: "억 원" },
  ];
}

/**
 * 수급 레이더 순위 줄의 검사 칸(작업대 P7 — 실행 명세 §7 7행 '레이더: 조밀 표와 검사'). 화면이 이미 읽은 응답만 씁니다 — 순위(그 줄), 수급 지속성
 * (stock-flows — 토스 공식), 재무(fundamentals — DART·금융위), 외국인·기관 공통(consensus). 검사 칸을 열어도 새 요청이 없습니다(radarInspector.test).
 * 응답에 그 종목이 없으면 '—'와 까닭, 아직 오지 않았으면 그 사실을 적습니다(0으로 채우지 않음). 링크: 종목 상세(/s/kr/{코드}), 공시 원문(DART — 새 창).
 */
export function RankingDetail({
  row,
  tradeType,
  source,
  flows,
  fundamentals,
  consensus,
}: {
  row: RadarRow;
  tradeType: string;
  source: string | null | undefined;
  flows: StockFlowsRead;
  fundamentals: FundamentalsRead;
  consensus: ConsensusRead;
}) {
  const stock = flows.data?.stocks.find((entry) => entry.code === row.code && entry.available);
  const company = fundamentals.data?.companies.find((entry) => entry.code === row.code);
  const common = consensus.data?.rows.find((entry) => entry.code === row.code);
  const flowsWait = readState(flows, "수급 지속성을");
  const fundamentalsWait = readState(fundamentals, "재무를");
  const consensusWait = readState(consensus, "공통 목록을");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PropertyList
        dense
        source={source ?? undefined}
        items={[
          { label: "종목코드", value: row.code, mono: true },
          { label: "순위", value: `${row.rank}위` },
          { label: "현재가", value: row.price, format: (value) => formatNumber(value, 0), unit: "원" },
          { label: "등락률", value: row.changePct === null ? null : <ChangeChip size="sm" changePct={row.changePct} /> },
          { label: "순매수대금", value: signedAmount(row.netAmountEok, 1), unit: "억 원" },
        ]}
      />

      <DetailSection title="수급 지속성 (주)">
        <PropertyList
          dense
          items={stock ? flowItems(stock) : []}
          placeholder={flowsWait ? <p className="py-1 text-sm text-text-3">{flowsWait}</p> : undefined}
          emptyText="이 종목의 투자자별 매매동향이 아직 수집되지 않았습니다(수집 전)."
          source={stock ? `${flows.data?.source ?? "토스증권 Open API (공식)"} · 기준일 ${stock.latestDate ?? "—"}${stock.provisional ? " 잠정" : ""}` : undefined}
        />
      </DetailSection>

      <DetailSection title="재무">
        <PropertyList
          dense
          items={company?.available ? fundamentalsItems(company) : []}
          placeholder={fundamentalsWait ? <p className="py-1 text-sm text-text-3">{fundamentalsWait}</p> : undefined}
          emptyText="이 종목의 DART 재무가 없습니다(ETF·ETN·스팩·신규 상장·수집 전)."
          source={company?.available ? `DART ${company.bsnsYear ?? ""} ${company.fsLabel ?? ""}`.trim() : undefined}
        />
      </DetailSection>

      <DetailSection title={`외국인·기관 공통 ${tradeType}`}>
        <PropertyList
          dense
          items={common ? consensusItems(common) : []}
          placeholder={consensusWait ? <p className="py-1 text-sm text-text-3">{consensusWait}</p> : undefined}
          emptyText={`공통 ${tradeType} 목록(두 상위 목록의 교집합)에 없습니다.`}
        />
      </DetailSection>

      <div className="flex flex-wrap gap-x-4">
        <Link href={`/s/kr/${row.code}`} className={LINK_CLASSES}>
          종목 상세
        </Link>
        {company?.dartUrl ? (
          <a href={company.dartUrl} target="_blank" rel="noopener noreferrer" className={`${LINK_CLASSES} gap-1`}>
            공시 원문
            <ExternalLinkIcon size={12} />
            <span className="sr-only">(새 창)</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}
