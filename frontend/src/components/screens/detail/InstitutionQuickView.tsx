"use client";

import Link from "@/components/ui/IntentLink";
import { type ReactElement, useState } from "react";
import { DataTable, PropertyList, ProvenanceBadge, Skeleton } from "@/components/patterns";
import { ErrorState, Freshness, LINK_CLASSES, ROW_TRIGGER } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useApi } from "@/hooks/useApi";
import { useSessionUser } from "@/hooks/useSessionUser";
import { institutionHref, institutionNames, parseStockRoute, stockHref } from "@/lib/detail";
import { institutionProperties } from "@/lib/detailEntity";
import { endpoints } from "@/lib/endpoints";
import { formatUsd, formatWeightPercent, withoutLeadingIcon } from "@/lib/format";
import { infoSearchEntry } from "@/lib/search";
import type { Holding, PortfolioResponse, SessionUser } from "@/lib/types";
import { propertyItems } from "./DetailParts";

/** 기관 상세·13F 포트폴리오 화면과 같은 요청 값(같은 응답 캐시). */
const QUARTERS = 8;
const TOP_N = 30;
/** 팝업에 보일 보유 종목 수 — 나머지는 기관 상세 화면의 '보유 종목'. */
const HOLDINGS_SHOWN = 10;

/**
 * 기관 팝업 창(사용자 요청 2026-11-22 — 모의매매 '신호 기관'의 기관 이름을 누르면 화면을 떠나지 않고). 그 기관의 13F 저장본(SEC EDGAR, 분기마다 45일 안에
 * 공시 — 지금 보유와 다를 수 있음)으로 기관 속성(CIK·보고 기준일·공시일·평가액·보유 종목 수·분기 수)과 비중 상위 보유 종목(지난 분기 대비 동작)을 보이고,
 * '기관 상세 화면 열기'가 있습니다. 보유 종목 이름은 그 종목 정보로 가는 링크입니다(2026-11-23 — 아래 HoldingNameLink). 13F 메뉴 밖의 신호 후보 기관은 트랙레코드 저장본을 읽습니다(백엔드 — 이름은 이 팝업이 받은 이름).
 * 열려 있을 때만 읽습니다. 종목 팝업(StockQuickView)과 같은 틀입니다.
 */
export function InstitutionQuickView({ cik, name, trigger }: { cik: string; name: string; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  const title = withoutLeadingIcon(name).trim() || `CIK ${cik}`;
  return (
    <Dialog open={open} onOpenChange={setOpen} title={title} trigger={trigger} size="lg">
      {open && <InstitutionQuickBody cik={cik} title={title} />}
    </Dialog>
  );
}

function InstitutionQuickBody({ cik, title }: { cik: string; title: string }) {
  const portfolio = useApi<PortfolioResponse>(endpoints.institution.portfolio(cik, QUARTERS, TOP_N));
  const data = portfolio.data;
  // 13F 메뉴 기관이면 응답의 이름(아이콘 뗌), 그 밖(이름 = CIK)은 받은 이름 그대로.
  const responseName = data?.institution?.name;
  const display = responseName && responseName !== cik ? institutionNames(responseName).display : title;
  const holdings = (data?.holdings ?? []).slice(0, HOLDINGS_SHOWN);
  const user = useSessionUser();

  let body;
  if (!data) {
    body =
      portfolio.errorStatus === 400 ? (
        <p className="break-keep text-sm text-text-2">이 기관의 13F 저장본이 없습니다(CIK {cik}).</p>
      ) : portfolio.error ? (
        <ErrorState message={portfolio.error} onRetry={() => void portfolio.reload()} />
      ) : (
        <Skeleton lines={6} label="13F 포트폴리오를 불러오는 중" />
      );
  } else if (!data.available) {
    body = <p className="text-sm text-text-2">{data.message ?? "13F 저장본이 없습니다."}</p>;
  } else {
    body = (
      <>
        <PropertyList items={propertyItems(institutionProperties(data, cik))} />
        <DataTable<Holding>
          caption={`${display} 비중 상위 보유 종목`}
          dense
          rows={holdings}
          rowKey={(holding) => `${holding.cusip}:${holding.class}`}
          emptyText="보유 종목이 없습니다."
          columns={[
            {
              key: "name",
              header: "종목",
              className: "break-keep",
              cell: (holding) => (
                <span className="flex min-w-0 flex-col items-start">
                  <HoldingNameLink holding={holding} user={user} />
                  {withoutLeadingIcon(holding.action) ? (
                    <span className="text-xs text-text-3">{withoutLeadingIcon(holding.action)}</span>
                  ) : null}
                </span>
              ),
            },
            { key: "weight", header: "비중", align: "right", cell: (holding) => formatWeightPercent(holding.weight) },
            { key: "value", header: "평가액", align: "right", cell: (holding) => formatUsd(holding.value) },
          ]}
        />
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2">
        <span className="tabular-nums">{display === title ? `CIK ${cik}` : `${display} · CIK ${cik}`}</span>
        {data?.latest ? (
          <span className="tabular-nums">
            보고 기준일 {data.latest.reportDate} · 공시일 {data.latest.filingDate}
          </span>
        ) : null}
        <ProvenanceBadge source="SEC EDGAR 13F" />
        {data ? <Freshness collectedAt={data.collectedAtKst} ageSeconds={data.ageSeconds} refreshError={portfolio.refreshError} /> : null}
      </div>
      {body}
      <p className="break-keep text-xs text-text-3">13F는 분기마다 45일 안에 공시됩니다 — 지금 보유와 다를 수 있습니다.</p>
      <Link href={institutionHref(cik)} className={`${LINK_CLASSES} self-start text-sm`}>
        기관 상세 화면 열기
      </Link>
    </div>
  );
}

/**
 * 팝업 보유 표의 종목 이름(사용자 요청 2026-11-23) — 누르면 그 종목 정보가 있는 곳으로 갑니다. 수집기가 붙인 티커가 그 줄의 것으로 확인되면 종목 상세
 * 화면(/s/us/<티커>), 티커가 없거나 같은 회사의 다른 클래스일 수 있는 줄(tickerIsProxy — 그 티커의 시세가 그 줄의 것처럼 보이면 안 됨, 13F 보유 표의
 * HoldingQuickLink와 같은 갈래)은 공시 이름으로 정보 검색(/search?q=), 정보 검색을 볼 수 없는 사용자면 글자 그대로. 링크 이름은 보이는 공시 이름이
 * 앞에 그대로 오고 갈 곳을 덧붙입니다(WCAG 2.5.3). 표의 데이터 칸이라 강조 파랑이 아니라 중립 잉크 + 마우스를 올리면 밑줄(ROW_TRIGGER — 줄 이름 단추와 같은 꼴).
 */
function HoldingNameLink({ holding, user }: { holding: Holding; user: SessionUser | null | undefined }) {
  const ticker = holding.ticker?.trim();
  const target = ticker && !holding.tickerIsProxy ? parseStockRoute("us", ticker) : null;
  const href = target ? stockHref(target.market, target.code) : (infoSearchEntry(holding.name ?? "", user)?.href ?? null);
  if (!href) return <span className="font-medium text-text wrap-anywhere">{holding.name}</span>;
  return (
    <Link href={href} className={`${ROW_TRIGGER} font-medium wrap-anywhere`}>
      {holding.name} <span className="sr-only">{target ? "종목 상세 화면" : "정보 검색"}</span>
    </Link>
  );
}
