package com.macrodash.feature.snapshot;

import com.macrodash.Kst;
import com.macrodash.feature.institution.Institutions;
import com.macrodash.feature.institution.Sec13FService;
import com.macrodash.feature.macro.LiquidityService;
import com.macrodash.feature.macro.MacroService;
import com.macrodash.feature.macro.SectorService;
import com.macrodash.feature.positioning.CotService;
import com.macrodash.feature.positioning.KrFlowsService;
import com.macrodash.feature.positioning.KrxService;
import com.macrodash.feature.positioning.RadarService;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 대시보드 원본 데이터 텍스트 생성 (AI 리포트 입력 · 복사용).
 *
 * <p>AI가 보는 텍스트와 화면이 보여 주는 숫자가 <b>같은 원본</b>에서 나오도록,
 * 이미 계산된 서비스 결과만 문자열로 옮깁니다. 여기서 다시 계산하지 않습니다.
 *
 * <p>주의: 추정치·대용 지표에는 경고 문구를 함께 넣습니다. AI가 "MOVE 140 이상은
 * 채권 발작"처럼 실제 지표 기준을 추정치에 적용하면 잘못된 결론이 나옵니다.
 */
@Service
public class SnapshotTextService {

    /** {@link #payload()}의 응답 캐시(ComputedCache) 키 — {@code /api/snapshot/text}가 씁니다. */
    public static final String CACHE_KEY = "snapshot.text";

    /** 원본 텍스트가 담는 영역 (화면 안내 문구가 실제 내용과 어긋나지 않도록 여기서 정의합니다). */
    static final List<String> SECTIONS = List.of(
            "거시경제 매크로 지표", "심화 매크로 지표", "금융 리스크·변동성", "연준 순유동성",
            "섹터 & 자산군 모멘텀", "글로벌 투기세력 (COT)", "국내 파생 (KRX)",
            "국내 수급 레이더", "기관 13F 스마트머니 교집합");

    private final MacroService macro;
    private final LiquidityService liquidity;
    private final SectorService sector;
    private final CotService cot;
    private final KrxService krx;
    private final RadarService radar;
    private final Sec13FService sec13f;
    private final KrFlowsService flows;

    public SnapshotTextService(MacroService macro, LiquidityService liquidity,
                               SectorService sector, CotService cot,
                               KrxService krx, RadarService radar,
                               Sec13FService sec13f, KrFlowsService flows) {
        this.macro = macro;
        this.liquidity = liquidity;
        this.sector = sector;
        this.cot = cot;
        this.krx = krx;
        this.radar = radar;
        this.sec13f = sec13f;
        this.flows = flows;
    }

    /** 전체 대시보드 원본 텍스트. */
    public String fullText() {
        return fullText(ZonedDateTime.now(Kst.ZONE));
    }

    /**
     * 화면의 "전체 대시보드 원본 데이터"와 AI 입력이 <b>같은 텍스트</b>를 쓰도록
     * 본문과 메타(생성 시각·분량)를 함께 돌려줍니다.
     *
     * <p>텍스트 하나를 두 경로가 따로 만들면, 사람이 복사해 둔 원본과 AI가 읽은
     * 원본이 달라질 수 있습니다. 여기서 한 번 만들어 둘 다에게 넘깁니다.
     */
    public Map<String, Object> payload() {
        ZonedDateTime now = ZonedDateTime.now(Kst.ZONE);
        String text = fullText(now);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("text", text);
        out.put("generatedAtKst", Kst.stamp(now));
        out.put("chars", text.length());
        out.put("lineCount", text.lines().count());
        out.put("sections", SECTIONS);
        return out;
    }

    private String fullText(ZonedDateTime generatedAt) {
        List<String> lines = new ArrayList<>();
        lines.add("📋 [Local Macro Dashboard — 수집 데이터 원본 스냅샷]");
        lines.add("생성 시각: " + Kst.stamp(generatedAt));
        lines.add("표기: 최신값 | 전일 종가 대비 | 전일 종가");
        // 값의 성격을 머리말에서 먼저 정의합니다. 같은 화면에 "어제 확정치"와
        // "지금 스크래핑 시세"가 함께 있는데, 복사해서 다른 곳에 붙이면 그 구분이
        // 사라집니다. 텍스트 자체가 구분을 들고 다니게 합니다.
        lines.add("성격 표기: [공식 확정치] 발표 기관의 확정값(하루 이상 지연) · "
                + "[실시간 참고] 공개 시세 스크래핑(비공식) · "
                + "[추정치] 확정치가 아닌 대용값 · [분기 공시] 45일 지연된 분기말 스냅샷");
        lines.add("=".repeat(72));
        lines.add("");

        appendMacro(lines);
        appendAdvanced(lines);
        appendRisk(lines);
        appendLiquidity(lines);
        appendRotation(lines);
        appendCot(lines);
        appendKrx(lines);
        appendRadar(lines);
        appendSec13F(lines);

        lines.add("=".repeat(72));
        lines.add("※ 수집 실패 항목은 숫자를 만들어내지 않고 '수집 실패'로 표기했습니다.");
        lines.add("※ '추정치'로 표시된 값은 공식 확정치가 아니며, 실제 지표의 임계치를 "
                + "그대로 적용하면 안 됩니다.");
        return String.join("\n", lines);
    }

    /**
     * 섹션 머리말 — 제목과 함께 <b>언제 받은 값인지</b>와 <b>어떤 성격의 값인지</b>를 답니다.
     *
     * <p>수집 시각이 없는 섹션(저장본이 없거나, 13F처럼 분기 기준값)에는
     * 그 줄을 쓰지 않습니다. "알 수 없음"을 시각처럼 적어 두면 읽는 쪽이
     * 오해합니다.
     */
    private void sectionHeader(List<String> lines, String title, String nature, Object collectedAtKst) {
        lines.add("## " + title);
        if (collectedAtKst != null && !String.valueOf(collectedAtKst).isBlank()) {
            lines.add("- 수집 시각: " + collectedAtKst);
        }
        lines.add("- 데이터 성격: " + nature);
    }

    /** 계약 수. 모르면 "데이터 없음". */
    static String contracts(Double value) {
        return value == null ? "데이터 없음" : "%,d".formatted(value.longValue());
    }

    private void appendMacro(List<String> lines) {
        Map<String, Object> overview = macro.overview();
        // 금리 카드도 TradingView 참고 시세입니다. 예전 머리말은 "미국채 금리는 FRED 일별 확정치"라고 적어
        // AI가 참고 시세를 공식 확정치로 읽었습니다(화면 카드는 "TradingView 참고"로 바르게 표시).
        // FRED 확정치는 아래 "공식 일별 10Y-2Y" 줄과 "심화 매크로 지표" 구간에만 있습니다.
        sectionHeader(lines, "거시경제 매크로 지표",
                "[실시간 참고] 환율·지수·원자재·미국채 금리는 Yahoo·TradingView 공개 시세 스크래핑"
                        + "(미국채 금리는 TradingView 참고 시세, 종목별 지연은 줄 끝 [ ]) · [공식 확정치] FRED 값은 '공식 일별' 줄과 심화 지표 구간",
                overview.get("collectedAtKst"));

        if (!Boolean.TRUE.equals(overview.get("available"))) {
            lines.add("- 매크로 데이터 수집 실패");
            lines.add("");
            return;
        }

        Object categories = overview.get("categories");
        if (categories instanceof JsonNode node && node.isArray()) {
            for (JsonNode category : node) {
                lines.add("### " + Json.asText(category, "title"));
                for (JsonNode item : Json.array(category, "items")) {
                    String status = Json.asText(item, "status");
                    String name = Json.asText(item, "name");
                    if ("ok".equals(status) || "single".equals(status)) {
                        lines.add("- %s: %s | %s | 전일: %s%s%s%s".formatted(
                                name,
                                orNa(Json.asText(item, "priceStr")),
                                orNa(Json.asText(item, "deltaStr")),
                                orNa(Json.asText(item, "prevStr")),
                                Json.asText(item, "prevSource") == null
                                        ? "" : " (" + Json.asText(item, "prevSource") + ")",
                                delayBadge(item),
                                staleNote(item)));
                    } else {
                        lines.add("- " + name + ": 데이터 수집 실패");
                    }
                }
            }
        }

        Object spreads = overview.get("spreads");
        if (spreads instanceof Map<?, ?> map) {
            lines.add("### 장단기 금리차");
            Object realtime = map.get("realtime");
            if (realtime instanceof Map<?, ?> rt) {
                // 만기를 문장에 박아 두지 않고 longKey/shortKey를 따라갑니다.
                // 같은 구조를 30Y-2Y에도 쓰기 때문에, 라벨을 고정해 두면 30년물
                // 수익률이 "10년물"로 적혀 AI 요약에 그대로 실려 나갑니다.
                String longYears = bondYears(rt.get("longKey"), "10");
                String shortYears = bondYears(rt.get("shortKey"), "2");
                lines.add("- 미국채 " + longYears + "년물: " + format(rt.get("longValue"), "%"));
                lines.add("- 미국채 " + shortYears + "년물: " + format(rt.get("shortValue"), "%"));
                lines.add("- " + longYears + "Y-" + shortYears + "Y 스프레드 (TradingView 참고 시세로 계산): "
                        + format(rt.get("spread"), "%p")
                        + (Boolean.TRUE.equals(rt.get("isStale")) ? " ⚠️ 수집 실패로 이전 금리가 섞임" : ""));
                lines.add("- 스프레드 직전 대비: " + format(rt.get("delta"), "%p"));
            }
            Object official = map.get("official10y2y");
            if (official instanceof Map<?, ?> off) {
                lines.add("- 공식 일별 10Y-2Y (FRED 확정치, 하루 지연): " + format(off.get("latest"), "%p"));
            }
        }
        lines.add("");
    }

    private void appendAdvanced(List<String> lines) {
        Map<String, Object> advanced = macro.advancedIndicators();
        sectionHeader(lines, "심화 매크로 지표 (FRED 공식)",
                "[공식 확정치] FRED 시계열 — 발표 주기에 따라 하루~한 주 지연",
                // 시리즈마다 발표 주기가 달라, 기준일은 항목마다 붙입니다.
                null);
        Object latest = advanced.get("latest");

        if (latest instanceof Map<?, ?> map) {
            for (Object value : map.values()) {
                if (!(value instanceof Map<?, ?> entry)) {
                    continue;
                }
                String label = String.valueOf(entry.get("label"));
                if (!Boolean.TRUE.equals(entry.get("available"))) {
                    lines.add("- " + label + ": 데이터 수집 실패");
                    continue;
                }
                StringBuilder text = new StringBuilder("- %s (%s): %s%s".formatted(
                        label, entry.get("id"),
                        format(entry.get("value"), ""), String.valueOf(entry.get("unit"))));
                if (entry.get("delta") instanceof Double delta) {
                    text.append(" (직전 대비 %+.3f)".formatted(delta));
                }
                if (entry.get("status") != null) {
                    text.append(" | 상태: ").append(entry.get("status"));
                }
                if (entry.get("percentile") instanceof Double percentile) {
                    text.append(" | 표본 백분위 %.1f%%".formatted(percentile));
                    // 표본 길이가 지표마다 다릅니다(IG는 FRED 제한으로 3년, 나머지는 약 10년).
                    if (entry.get("percentileFrom") != null && entry.get("percentileCount") instanceof Integer count
                            && entry.get("percentileYears") instanceof Double years) {
                        text.append(" (%s 이후 %,d개, 약 %.1f년)".formatted(entry.get("percentileFrom"), count, years));
                    }
                }
                if (entry.get("asOf") != null) {
                    text.append(" | 기준일 ").append(entry.get("asOf"));
                }
                lines.add(text.toString());
            }
        }

        Object derived = advanced.get("derived");
        if (derived instanceof Map<?, ?> map && map.get("decomposition") != null) {
            lines.add("- 금리 분해: " + map.get("decomposition"));
        }
        lines.add("");
    }

    private void appendRisk(List<String> lines) {
        Map<String, Object> risk = macro.riskIndicators();
        sectionHeader(lines, "금융 리스크·은행권·시장 변동성",
                "[공식 확정치] FRED 신용 스프레드·금융스트레스 · "
                        + "[추정치] MOVE는 대용값일 수 있음(항목별 경고 참조)",
                // 지표마다 기준일이 달라 섹션 하나로 묶을 수 없습니다. 항목마다 붙입니다.
                null);

        appendRiskEntry(lines, risk.get("vix"), "CBOE VIX (주식 변동성)");
        appendRiskEntry(lines, risk.get("move"), "MOVE (채권 변동성)");
        appendRiskEntry(lines, risk.get("hyOas"), "미국 하이일드 스프레드 (HY OAS)");
        appendRiskEntry(lines, risk.get("cpSpread"), "3M 금융 CP 스프레드");
        appendRiskEntry(lines, risk.get("stlfsi"), "세인트루이스 연준 금융스트레스");
        lines.add("");
    }

    private void appendRiskEntry(List<String> lines, Object value, String label) {
        if (!(value instanceof Map<?, ?> entry) || !Boolean.TRUE.equals(entry.get("available"))) {
            lines.add("- " + label + ": 데이터 수집 실패");
            return;
        }
        StringBuilder text = new StringBuilder("- %s: %s".formatted(
                label, format(entry.get("value"), "")));
        if (entry.get("delta") instanceof Double delta) {
            text.append(" (직전 대비 %+.2f)".formatted(delta));
        }
        // 지표마다 기준일이 다릅니다(VIX는 전일 마감, STLFSI4는 주간). 값 옆에
        // 같이 적지 않으면 서로 다른 날짜의 숫자가 한 문단에서 비교됩니다.
        Object asOf = entry.get("asOf") != null ? entry.get("asOf") : entry.get("collectedAtKst");
        if (asOf != null) {
            text.append(" | 기준일 ").append(asOf);
        }
        if (Boolean.TRUE.equals(entry.get("isProxy"))) {
            // AI가 공식 지표로 오인하지 않도록 요약 문장 자체에 경고를 답니다.
            text.append(" ⚠️ 주의: 공식 지표가 아닌 추정치입니다 — ")
                    .append(entry.get("sourceLabel"));
        }
        lines.add(text.toString());
    }

    private void appendLiquidity(List<String> lines) {
        Map<String, Object> result = liquidity.netLiquidity(3);
        sectionHeader(lines, "연준 순유동성 (WALCL − TGA − ON RRP)",
                Boolean.TRUE.equals(result.get("isEstimated"))
                        ? "[추정치] FRED 확정치가 아닙니다"
                        : "[공식 확정치] FRED 주간(WALCL)·일별(TGA·RRP) 확정치",
                result.get("collectedAtKst"));

        if (!Boolean.TRUE.equals(result.get("available"))) {
            lines.add("- 순유동성 데이터 수집 실패");
            lines.add("");
            return;
        }
        if (Boolean.TRUE.equals(result.get("isEstimated"))) {
            lines.add("- ⚠️ 주의: 추정치 모드입니다 (FRED 확정치 아님)");
        }

        Object latest = result.get("latest");
        if (latest instanceof Map<?, ?> map) {
            lines.add("- 기준일: " + map.get("date"));
            // 단위는 화면과 같게 조·억으로 맞춥니다. AI가 "십억"과 "조"를 섞어
            // 읽으면 자릿수를 한 번 더 옮겨야 하고, 그 과정에서 틀립니다.
            lines.add("- 순유동성: " + formatUsdFromTrillions(map.get("netLiquidityT")));
            lines.add("- 직전 대비: " + formatUsdFromTrillions(map.get("deltaT")));
            lines.add("- 연준 총자산(WALCL): " + formatUsdFromTrillions(map.get("walclT")));
            // TGA·RRP는 억 단위로 읽히지만, 순유동성과 맞춰 보려면 조로 옮겨야 합니다. AI가 이 환산을 틀려
            // ("역레포 23.4억 달러" → 0.0234조) 맞는 순유동성을 "계산 불일치"로 보고했습니다. 같은 단위의 값과
            // 계산식을 함께 적어, 다시 계산해도 같은 답이 나오게 합니다.
            lines.add("- 재무부 일반계정(TGA): " + formatUsdFromBillions(map.get("tgaB"))
                    + inTrillions(map.get("tgaB")));
            lines.add("- 역레포(ON RRP): " + formatUsdFromBillions(map.get("rrpB"))
                    + inTrillions(map.get("rrpB")));
            if (map.get("walclT") instanceof Number walcl && map.get("tgaB") instanceof Number tga
                    && map.get("rrpB") instanceof Number rrp && map.get("netLiquidityT") instanceof Number net) {
                lines.add("- 계산 (조 달러, 각 값 반올림): %.4f − %.4f − %.4f = %.4f".formatted(
                        walcl.doubleValue(), tga.doubleValue() / 1000.0, rrp.doubleValue() / 1000.0,
                        net.doubleValue()));
            }
        }
        // 4주·12주 변화는 날짜 기준(행 수 아님)으로 백엔드가 계산한 값입니다. 빠져 있어 AI가 "데이터 없음"으로
        // 적었습니다 — 리포트 프롬프트가 유동성 판단의 근거로 요구하는 값입니다.
        if (result.get("momentum") instanceof Map<?, ?> momentum) {
            lines.add("- 4주 변화: " + formatUsdFromTrillions(momentum.get("change4w"))
                    + " · 12주 변화: " + formatUsdFromTrillions(momentum.get("change12w")));
        }
        lines.add("");
    }

    private void appendRotation(List<String> lines) {
        Map<String, Object> rotation = sector.rotation("3M");
        sectionHeader(lines, "섹터 & 자산군 모멘텀 (3개월 기준 상위)",
                "[실시간 참고] ETF 종가 기반 수익률 — 직전 거래일 마감 기준",
                rotation.get("collectedAtKst"));

        if (!Boolean.TRUE.equals(rotation.get("available"))) {
            lines.add("- 섹터 데이터 수집 실패");
            lines.add("");
            return;
        }

        appendRotationRows(lines, rotation.get("sectors"), "섹터");
        appendRotationRows(lines, rotation.get("assetClasses"), "자산군");
        lines.add("");
    }

    @SuppressWarnings("unchecked")
    private void appendRotationRows(List<String> lines, Object rows, String label) {
        if (!(rows instanceof List<?> list) || list.isEmpty()) {
            lines.add("- " + label + ": 데이터 없음");
            return;
        }
        lines.add("### " + label);
        list.stream()
                .map(row -> (Map<String, Object>) row)
                .sorted((a, b) -> Double.compare(
                        returnValue(b, "3M"), returnValue(a, "3M")))
                .limit(6)
                .forEach(row -> lines.add("- %s (%s): 1주 %s · 1개월 %s · 3개월 %s%s".formatted(
                        row.get("name"), row.get("ticker"),
                        formatReturn(row, "1W"), formatReturn(row, "1M"), formatReturn(row, "3M"),
                        staleNote(row))));
    }

    /**
     * 수집 실패로 직전 계열을 이어받은 섹터·자산군 행(isStale, 최대 3일)이면 매크로 카드({@link #staleNote(JsonNode)})와
     * 같은 꼬리를 붙입니다(QA-095). 붙이지 않으면 AI가 멈춘 수익률을 '직전 거래일 마감' 값으로 읽고 순위·흐름을 씁니다.
     * 순위에서 빼지 않고 표시만 합니다 — 이전 값은 버리지 않고 표시한다는 원칙(QA-065 업종 화면과 같음).
     */
    private static String staleNote(Map<String, Object> row) {
        if (!Boolean.TRUE.equals(row.get("isStale"))) {
            return "";
        }
        Object reason = row.get("staleReason");
        return " ⚠️ 이전 값(이번 수집 실패" + (reason == null ? "" : ": " + reason) + ")";
    }

    @SuppressWarnings("unchecked")
    private double returnValue(Map<String, Object> row, String window) {
        Object returns = row.get("returns");
        if (returns instanceof Map<?, ?> map && map.get(window) instanceof Double value) {
            return value;
        }
        return Double.NEGATIVE_INFINITY;
    }

    private String formatReturn(Map<String, Object> row, String window) {
        double value = returnValue(row, window);
        return value == Double.NEGATIVE_INFINITY ? "데이터 없음" : "%+.2f%%".formatted(value);
    }

    private void appendCot(List<String> lines) {
        Map<String, Object> overview = cot.overview();
        sectionHeader(lines, "글로벌 투기세력 (CFTC COT · 주 1회 공시)",
                "[공식 확정치] CFTC 주간 공시 — 화요일 기준값이 금요일에 나옵니다(수일 지연)",
                overview.get("collectedAtKst"));

        if (!Boolean.TRUE.equals(overview.get("available"))) {
            lines.add("- COT 데이터 수집 실패");
            lines.add("");
            return;
        }

        Object assets = overview.get("assets");
        if (assets instanceof List<?> list) {
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> entry)) {
                    continue;
                }
                if (!Boolean.TRUE.equals(entry.get("available"))) {
                    lines.add("- " + entry.get("asset") + ": 데이터 없음 "
                            + (entry.get("error") == null ? "" : "(" + entry.get("error") + ")"));
                    continue;
                }
                lines.add("- %s (기준일 %s, %s일 전 공시)".formatted(
                        entry.get("asset"), entry.get("date"), entry.get("ageDays")));
                lines.add("  - 비상업/스마트머니 순포지션: " + format(entry.get("ncNet"), " 계약"));
                lines.add("  - 상업/헤저 순포지션: " + format(entry.get("commNet"), " 계약"));
                lines.add("  - 변화: 1주 %s · 4주 %s · 13주 %s".formatted(
                        format(entry.get("change1w"), ""), format(entry.get("change4w"), ""),
                        format(entry.get("change13w"), "")));
                lines.add("  - 표본 내 백분위: " + format(entry.get("percentile"), "%"));
            }
        }
        lines.add("");
    }

    private void appendKrx(List<String> lines) {
        Map<String, Object> futures = krx.futures(40);
        sectionHeader(lines, "국내 파생 (KOSPI200 선물)",
                Boolean.TRUE.equals(futures.get("isEstimated"))
                        ? "[추정치] KODEX 200 기반 — KRX 확정치가 아닙니다"
                        : "[공식 확정치] KRX 일별 마감값",
                futures.get("collectedAtKst"));

        if (!Boolean.TRUE.equals(futures.get("available"))) {
            lines.add("- KRX 선물 데이터 수집 실패");
        } else {
            if (Boolean.TRUE.equals(futures.get("isEstimated"))) {
                lines.add("- ⚠️ 주의: KODEX 200 기반 추정치입니다 (KRX 확정치 아님). "
                        + "미결제약정·베이시스는 추정하지 않습니다.");
            }
            Object latest = futures.get("latest");
            if (latest instanceof Map<?, ?> map) {
                lines.add("- 기준일: " + map.get("date") + " (" + map.get("contractName") + ")");
                lines.add("- 선물 종가: " + format(map.get("futuresClose"), ""));
                lines.add("- 등락률: " + format(map.get("changePct"), "%"));
                lines.add("- 미결제약정: " + format(map.get("openInterest"), " 계약")
                        + " (증감 " + format(map.get("oiChange"), "") + ")");
                lines.add("- 시장 베이시스: " + format(map.get("marketBasis"), "")
                        + " — " + map.get("basisState"));
                lines.add("- 4대 국면: " + map.get("marketPhase"));
                lines.add("- 한국판 COT OI Index: " + format(map.get("cotOiIndex"), "%"));
            }
        }

        Map<String, Object> trend = krx.investorTrend();
        if (Boolean.TRUE.equals(trend.get("available"))) {
            lines.add("### 투자주체별 선물 수급 (%s 기준, 기준일 %s)".formatted(
                    trend.get("unit"), trend.get("dataDate")));
            Object rows = trend.get("rows");
            if (rows instanceof JsonNode node && node.isArray()) {
                for (JsonNode row : node) {
                    // 값을 모르면 "데이터 없음". path().asDouble(0)은 0계약으로 적어 AI가 '거래 없음'으로 읽습니다.
                    lines.add("- %s: 당일 %s · 5일 %s · 20일 %s (%s)".formatted(
                            Json.asText(row, "investor"),
                            contracts(Json.asDouble(row, "netToday")),
                            contracts(Json.asDouble(row, "net5d")),
                            contracts(Json.asDouble(row, "net20d")),
                            orNa(Json.asText(row, "stance"))));
                }
            }
        } else {
            lines.add("- 투자주체별 선물 수급: 데이터 없음");
        }
        lines.add("");
    }

    private void appendRadar(List<String> lines) {
        // 조합마다 저장본이 따로라 수집 시각은 머리말이 아니라 조합마다 적습니다(QA-096). 기준일은 출처 문구에 있고,
        // 주말·장 전에는 전 거래일 값이므로 머리말에서 '당일'로 단정하지 않습니다.
        sectionHeader(lines, "국내 수급 레이더 (코스피)",
                "[실시간 참고] 공개 수급 순위 스크래핑 — 잠정치이며 마감 후 정정될 수 있습니다. "
                        + "기준일은 조합마다 출처에, 수집 시각은 그 옆에 적었습니다",
                null);

        for (String[] combination : new String[][]{
                {"외국인", "순매수"}, {"기관", "순매수"}, {"외국인", "순매도"}}) {
            Map<String, Object> result = radar.ranking(
                    "KOSPI", combination[0], combination[1], 30, "TODAY", null);

            lines.add("### %s %s 상위".formatted(combination[0], combination[1]));
            if (!Boolean.TRUE.equals(result.get("available"))) {
                lines.add("- 데이터 없음");
                continue;
            }
            Object collectedAt = result.get("collectedAtKst");
            lines.add("(출처: " + result.get("source")
                    + (collectedAt == null ? "" : " · 수집 시각 " + collectedAt) + ")");
            if (Boolean.TRUE.equals(result.get("stale"))) {
                // 화면 레이더의 '오래됨' 배지와 같은 판정(저장본이 15분 넘게 새로 받지 못함). 수집기가 멈추면 같은 날의
                // 오전 순위가 오후 리포트에 들어가는데, 출처의 기준일은 오늘이라 날짜만으로는 알 수 없습니다.
                lines.add("- ⚠️ 오래된 저장본 — "
                        + (result.get("ageSeconds") instanceof Number age
                                ? "수집한 지 %d분이 지났습니다. ".formatted(age.longValue() / 60) : "")
                        + "지금의 수급이 아닐 수 있습니다");
            }
            if (Boolean.TRUE.equals(result.get("isHistorical"))) {
                lines.add("- ⚠️ 주의: " + result.get("warning"));
            }

            Object rows = result.get("rows");
            if (rows instanceof JsonNode node && node.isArray()) {
                int shown = 0;
                for (JsonNode row : node) {
                    // path(..).asDouble()은 값이 없으면 0.0이라 "0.00억원"이 사실처럼 적혔습니다.
                    // null을 그대로 넘겨 format()이 "데이터 없음"으로 적게 합니다(단위도 함께).
                    lines.add("- %s (%s): %s · 현재가 %s (%s)".formatted(
                            Json.asText(row, "name"), Json.asText(row, "code"),
                            format(Json.asDouble(row, "netAmountEok"), "억원"),
                            format(Json.asDouble(row, "price"), ""),
                            format(Json.asDouble(row, "changePct"), "%")));
                    if (++shown >= 10) {
                        break;
                    }
                }
            }
        }
        appendMarketFlows(lines);
        lines.add("");
    }

    /**
     * 시장 전체 투자자별 매매대금 (토스증권 공식) — 레이더 순위가 "종목"이라면 이것은 "시장 전체의 방향".
     *
     * <p>값이 없는 날(null)은 누적에서 빠지고, 그 사실을 일수로 함께 적습니다.
     */
    @SuppressWarnings("unchecked")
    private void appendMarketFlows(List<String> lines) {
        Map<String, Object> result = flows.marketFlows();
        lines.add("### 시장 전체 투자자별 순매수 대금 (토스증권 공식, 원)");
        if (!Boolean.TRUE.equals(result.get("available"))) {
            lines.add("- 데이터 없음");
            return;
        }
        Map<String, Object> markets = (Map<String, Object>) result.get("markets");
        for (Map.Entry<String, Object> entry : markets.entrySet()) {
            Map<String, Object> summary = (Map<String, Object>) entry.getValue();
            // 수집 실패로 이어받은 시장이면 그렇다고 적습니다(QA-076) — 저장본 수집 시각은 다른 시장의 것입니다.
            lines.add("%s — 기준일 %s%s%s".formatted(entry.getKey(), summary.get("latestDate"),
                    Boolean.TRUE.equals(summary.get("provisional")) ? " (장중 잠정치)" : "",
                    Boolean.TRUE.equals(summary.get("isStale"))
                            ? " ⚠️ 이전 값(이번 수집 실패" + (summary.get("staleReason") == null ? ""
                                    : ": " + summary.get("staleReason")) + ")"
                            : ""));
            for (Map<String, Object> row : (List<Map<String, Object>>) summary.get("investors")) {
                lines.add("- %s: 최근일 %s · 5일 %s · 20일 %s".formatted(
                        row.get("label"), eok(row.get("latest")),
                        eokWindow(row.get("net5")), eokWindow(row.get("net20"))));
            }
        }
    }

    private static String eok(Object won) {
        return won instanceof Number number ? "%+,.0f억".formatted(number.doubleValue() / 1e8) : "데이터 없음";
    }

    @SuppressWarnings("unchecked")
    private static String eokWindow(Object window) {
        if (!(window instanceof Map<?, ?> map)) {
            return "데이터 없음";
        }
        Map<String, Object> w = (Map<String, Object>) map;
        String text = eok(w.get("sum"));
        return ((Number) w.get("days")).intValue() < ((Number) w.get("window")).intValue() && w.get("sum") != null
                ? text + "(" + w.get("days") + "일)" : text;
    }

    /**
     * 기관 13F — 여러 기관이 함께 담은 종목(교집합)만 옮깁니다.
     *
     * <p>기관 12곳의 보유 종목을 전부 실으면 텍스트가 수천 줄이 되고, AI 프롬프트도
     * 그만큼 길어져 응답이 느려집니다. 화면의 "13F Money 교집합"과 <b>같은 집계</b>를
     * 상위 15종목까지만 싣습니다.
     *
     * <p>주의: 13F는 분기 공시이고 45일 지연입니다. 지금 포지션이 아니라 지난 분기말
     * 스냅샷이라는 점을 텍스트 자체가 들고 다녀야 합니다 — 복사해서 다른 곳에
     * 붙이면 화면의 경고 문구가 따라가지 않기 때문입니다.
     */
    private void appendSec13F(List<String> lines) {
        List<String> ciks = Institutions.ALL.stream()
                .map(entry -> entry.get("cik"))
                .toList();
        Map<String, Object> consensus = sec13f.consensus(ciks, null, 2, 15);

        sectionHeader(lines, "기관 13F 스마트머니 교집합 (SEC 13F)",
                "[분기 공시] SEC 13F — 45일 지연된 분기말 스냅샷이며 현재 포지션이 아닙니다",
                // 분기 공시라 "수집 시각"이 값의 시점을 말해 주지 못합니다.
                // 대신 아래에 기준 분기를 적습니다.
                null);

        if (!Boolean.TRUE.equals(consensus.get("available"))) {
            lines.add("- 13F 데이터 없음 (수집기의 weekly 작업을 실행하세요)");
            lines.add("");
            return;
        }

        Object dates = consensus.get("availableDates");
        if (dates instanceof List<?> list && !list.isEmpty()) {
            List<String> stored = list.stream().map(String::valueOf).limit(8).toList();
            lines.add("- 기준 분기: " + stored.get(0)
                    + " (저장된 분기: " + String.join(", ", stored) + ")");
        }
        lines.add("- 집계 기관 수: " + consensus.get("participantCount")
                + "곳 (2곳 이상 보유한 종목만)");

        Object rows = consensus.get("rows");
        if (rows instanceof List<?> list) {
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> row)) {
                    continue;
                }
                lines.add("- %s: 보유 %s곳 · 합산 평가액 %s · 평균 비중 %s · 신규/확대 %s곳 · 축소/청산 %s곳"
                        .formatted(
                                row.get("name"),
                                String.valueOf(row.get("holderCount")),
                                formatUsd(row.get("totalValue")),
                                format(row.get("avgWeight"), "%"),
                                String.valueOf(row.get("buyCount")),
                                String.valueOf(row.get("sellCount"))));
            }
        }
        lines.add("");
    }

    /**
     * 달러 금액을 화면과 <b>같은 규칙</b>(조·억)으로 적습니다.
     *
     * <p>화면이 "2,992억 달러"로 보여 주는 값을 텍스트가 "$299.25B"로 적으면,
     * 같은 숫자를 두 번 다르게 말하는 셈입니다. 단위 체계를 하나로 맞춥니다.
     */
    private String formatUsd(Object value) {
        if (!(value instanceof Number number)) {
            return "데이터 없음";
        }
        return koreanScale(number.doubleValue(), "달러");
    }

    /** 조 달러 단위로 들어온 값(netLiquidityT 등). */
    private String formatUsdFromTrillions(Object value) {
        return value instanceof Number number
                ? koreanScale(number.doubleValue() * 1e12, "달러") : "데이터 없음";
    }

    /** 십억 달러 단위로 들어온 값(TGA·RRP). */
    private String formatUsdFromBillions(Object value) {
        return value instanceof Number number
                ? koreanScale(number.doubleValue() * 1e9, "달러") : "데이터 없음";
    }

    /** 십억 달러 값을 " (= 0.0023조 달러)"처럼 조 단위로 덧붙입니다. 모르면 빈 문자열. */
    private static String inTrillions(Object billions) {
        return billions instanceof Number number
                ? " (= %.4f조 달러)".formatted(number.doubleValue() / 1000.0) : "";
    }

    /** 조(1e12)·억(1e8) 표기. 화면의 formatUsd/formatKrw와 같은 규칙입니다. */
    private String koreanScale(double amount, String suffix) {
        double magnitude = Math.abs(amount);
        if (magnitude >= 1e12) {
            // 자릿수가 커질수록 소수는 의미를 잃습니다. "8,607.639조"에서 뒤
            // 세 자리는 6,390억인데, 8,607조 옆에서는 자릿수만 헷갈리게 합니다.
            if (magnitude >= 1e15) {
                return "%,.0f조 %s".formatted(amount / 1e12, suffix);
            }
            if (magnitude >= 1e14) {
                return "%,.1f조 %s".formatted(amount / 1e12, suffix);
            }
            return "%,.3f조 %s".formatted(amount / 1e12, suffix);
        }
        if (magnitude >= 1e8) {
            return magnitude >= 1e11
                    ? "%,.0f억 %s".formatted(amount / 1e8, suffix)
                    : "%,.1f억 %s".formatted(amount / 1e8, suffix);
        }
        if (magnitude >= 1e4) {
            return "%,.0f만 %s".formatted(amount / 1e4, suffix);
        }
        return "%,.0f %s".formatted(amount, suffix);
    }

    /**
     * 수집 실패로 직전 값을 이어받은 카드(isStale)면 그 사실과 사유·시각을 붙입니다(QA-030). 붙이지 않으면 AI가 몇 시간
     * 지난 값을 지금 값으로 읽습니다.
     */
    /**
     * 카드의 지연 배지("실시간"·"10분 지연"). 머리말의 [실시간 참고]는 '공개 시세 스크래핑'이라는 성격이고, 값마다
     * 실제 지연은 10~20분까지 다릅니다 — 줄마다 붙이지 않으면 늦은 값이 실시간으로 읽힙니다(QA-137).
     * 이어받은 값은 staleNote가 사유와 시각을 적으므로 붙이지 않습니다.
     */
    private static String delayBadge(JsonNode item) {
        String note = Json.asText(item, "note");
        if (note == null || note.isBlank() || Json.asBoolean(item, "isStale")) {
            return "";
        }
        return " [" + note + "]";
    }

    private static String staleNote(JsonNode item) {
        if (!Json.asBoolean(item, "isStale")) {
            return "";
        }
        String reason = Json.asText(item, "staleReason");
        String taken = Json.asText(item, "lastTs");
        return " ⚠️ 이전 값(이번 수집 실패" + (reason == null ? "" : ": " + reason) + ")"
                + (taken == null ? "" : " · " + taken);
    }

    private String orNa(String value) {
        return value == null ? "N/A" : value;
    }

    /**
     * "us10y" → "10". 만기 키에서 연수만 뽑습니다.
     *
     * <p>키가 없거나 형식이 다르면 기본값을 씁니다. 여기서 예외를 던지면
     * 스냅샷 텍스트 전체가 사라지는데, 라벨 한 줄 때문에 그럴 이유는 없습니다.
     */
    private String bondYears(Object key, String fallback) {
        if (key instanceof String text && text.length() > 3
                && text.startsWith("us") && text.endsWith("y")) {
            String digits = text.substring(2, text.length() - 1).replaceFirst("^0+", "");
            if (!digits.isEmpty() && digits.chars().allMatch(Character::isDigit)) {
                return digits;
            }
        }
        return fallback;
    }

    private String format(Object value, String unit) {
        if (value == null) {
            return "데이터 없음";
        }
        if (value instanceof Double d) {
            return "%,.2f%s".formatted(d, unit);
        }
        if (value instanceof Number n) {
            return "%,.2f%s".formatted(n.doubleValue(), unit);
        }
        return String.valueOf(value) + unit;
    }

    /**
     * 세 리포트가 함께 쓰는 규칙. 종류별 프롬프트 앞에 붙습니다.
     *
     * <p>규칙마다 이유를 짧게 붙입니다 — 이유를 아는 모델이 경계 사례를 더 잘 판단합니다. 형식 규칙은 화면
     * ({@code frontend/src/lib/markdown.ts})이 그릴 수 있는 범위와 맞춰 두었습니다. 바꾸면 둘을 같이 바꾸세요.
     */
    static final String REPORT_COMMON_RULES = """
            모든 답변은 한국어로 씁니다.

            [근거]
            - <data> 태그 안의 원본 데이터만 근거로 삼습니다. 데이터에 없는 수치·사건·전망치는 만들지 않습니다.
              확인할 수 없는 것은 "데이터 없음"이라고 씁니다. 이 리포트를 읽는 사람은 숫자를 그대로 믿기 때문입니다.
            - 수치를 인용할 때는 원본의 값과 단위를 그대로 쓰고, 기준일이나 수집 시각이 있으면 함께 적습니다.
            - 원본에 이미 계산된 값(순유동성, 스프레드, 백분위, 누적 수급, 국면 판정)은 다시 계산하지 말고 인용합니다.
              직접 계산해야 하면 단위를 먼저 맞춥니다(1조 = 10,000억). 단위가 섞인 재계산은 틀리기 쉽습니다.
            - 같은 지표가 두 출처로 나오면(예: TradingView 참고 시세로 계산한 스프레드와 FRED 공식 일별 값) 시점과
              출처가 다른 값이므로 "불일치"로 단정하지 말고, 공식 값을 기준으로 쓰되 차이가 있다는 사실만 적습니다.
            - 원본의 성격 표기를 지킵니다. [추정치]·대용값에는 실제 지표의 임계치를 적용하지 않습니다. "⚠️ 이전 값"은
              최신 값이 아니고, "데이터 수집 실패"는 판단에서 뺐다고 밝힙니다. 13F(분기 공시, 45일 지연)와
              COT(주 1회 공시)는 지금의 포지션이 아니라는 점을 해석에 반영합니다.

            [관점]
            - 이 리포트는 데이터 해석이지 투자 권유가 아닙니다. 특정 종목이나 자산의 매수·매도·비중을 지시하지 않습니다.
              대신 "어떤 신호가 확인되면 무엇을 뜻하는지"를 시나리오로 씁니다.
            - 판단에는 근거 수치를 붙이고, 근거가 약하면 "판단 보류"라고 씁니다.

            [형식 — 화면이 이 형식으로 그립니다]
            - 절 제목은 "## 1. 제목"처럼 ##과 번호로 씁니다. 절 안의 소제목이 필요하면 ###을 씁니다.
            - 표는 Markdown 표로 씁니다(머리 줄, 둘째 줄 |---|). 한 표는 8행 이내, 칸 안의 문장은 짧게 씁니다.
            - 목록은 "- "로 시작하고 중첩하지 않습니다. 강조는 **굵게**만 씁니다. HTML, 코드 블록, 각주, 이모지
              장식은 쓰지 않습니다.
            - 방향은 🟢(우호·상승), 🔴(비우호·하락), ⚪(중립·판단 보류) 세 기호로만 표시합니다. 원본의 수급 판정
              기호와 같은 뜻입니다.
            - 서론과 맺음말은 쓰지 않습니다. 전체 분량은 공백 포함 3,000~4,500자로 맞춥니다.
            - 아래 [절 구성]의 절을 그 순서와 제목 그대로 모두 씁니다. 데이터가 없는 절도 제목을 쓰고 "데이터 없음"이라고 적습니다.
            """;

    /** 리포트 종류별 시스템 프롬프트(공통 규칙 + 역할 + 절 구성). 화면 표시 순서를 지킵니다. */
    public Map<String, String> reportPrompts() {
        Map<String, String> prompts = new LinkedHashMap<>();
        prompts.put("종합 매크로 브리핑", REPORT_COMMON_RULES + """

                [역할]
                당신은 글로벌 매크로 전략가입니다. 금리·달러·유동성·신용·변동성·자산군 흐름을 서로 연결해 지금 시장이
                어떤 국면인지 판단합니다. 지표를 나열하지 말고, 지표들이 같은 방향을 가리키는지 엇갈리는지를 짚습니다.

                [절 구성]
                ## 1. 핵심 요약
                "- **[주제]** 판단 한 문장 (근거 수치)" 형식으로 4~5줄. 첫 줄은 전체 국면 판단입니다.
                ## 2. 데이터 신뢰도
                판단에 영향을 주는 항목만 표로(항목 | 상태 | 해석에 미치는 영향), 최대 6행. 추정치·이전 값·수집 실패·지연 데이터.
                ## 3. 금리와 달러
                표(지표 | 값 | 변화 | 방향) 뒤에 해석 2~3줄. 실질금리·기대인플레·장단기 금리차·달러 인덱스·원/달러.
                ## 4. 유동성과 신용
                순유동성(4주·12주 변화 포함)·하이일드·IG 스프레드·금융상황지수. 표와 해석 2~3줄.
                ## 5. 위험자산과 자산군 흐름
                주가지수·변동성·섹터/자산군 모멘텀·COT 투기 포지션의 극단 여부. 표와 해석 2~3줄.
                ## 6. 시나리오
                표(시나리오 | 확인할 신호 | 의미) 3행 — 기본·상방·하방.
                ## 7. 다음에 확인할 지표
                표(우선순위 | 지표 | 이유) 5행 이내.
                """);
        prompts.put("국내 파생·수급 분석", REPORT_COMMON_RULES + """

                [역할]
                당신은 KOSPI200 지수선물·베이시스·미결제약정·투자주체 수급을 분석하는 애널리스트입니다. 근거로 볼 구간은
                "국내 파생 (KOSPI200 선물)", "투자주체별 선물 수급", "국내 수급 레이더", 아시아 지수·야간선물, 원/달러입니다.
                선물과 현물 수급이 같은 방향인지, 외국인 선물 포지션의 누적이 어디까지 왔는지를 짚습니다.

                [절 구성]
                ## 1. 핵심 요약
                4줄 — 선물 국면 / 외국인 선물 / 현물 수급 / 환율·해외 변수. "- **[주제]** 판단 (근거 수치)" 형식.
                ## 2. 데이터 신뢰도
                판단에 영향을 주는 항목만 표로, 최대 5행. 장중 잠정치·추정치·지연 여부.
                ## 3. 선물 국면
                표(지표 | 값 | 판단): 종가·등락률·미결제약정 증감·베이시스·4대 국면·OI Index. 등락률이 '판정 불가'면
                국면을 단정하지 않고 그렇다고 씁니다.
                ## 4. 투자주체 수급
                선물 표(주체 | 당일 | 5일 | 20일 | 방향)와 현물 순매수 상위에서 외국인·기관이 함께 사거나 판 종목 3~5개.
                ## 5. 시나리오
                표(시나리오 | 확인할 신호 | 의미) 3행.
                ## 6. 다음 거래일 점검 목록
                표(우선순위 | 항목 | 이유) 5행 이내.
                """);
        prompts.put("13F 스마트머니 테마", REPORT_COMMON_RULES + """

                [역할]
                당신은 미국 기관 13F 공시를 분석하는 애널리스트입니다. 근거는 "기관 13F 스마트머니 교집합" 구간이고,
                매크로 구간은 테마의 배경을 설명할 때만 인용합니다. 13F는 분기말 스냅샷이고 45일 뒤 공시되며 미국 상장
                롱 포지션만 담는다는 점을 전제로, 여러 기관이 같은 방향으로 움직인 종목에서 테마를 찾습니다.

                [절 구성]
                ## 1. 핵심 요약
                테마 3~4줄. "- **[테마]** 한 문장 (근거: 종목·기관 수)" 형식.
                ## 2. 데이터 신뢰도
                기준 분기·참여 기관 수·공시 지연·평가액을 모르는 항목을 표로, 최대 4행.
                ## 3. 공통 보유 상위
                표(종목 | 보유 기관 수 | 동시 매수 | 동시 매도 | 평균 비중) 8행 이내.
                ## 4. 테마
                ### 소제목으로 테마 2~3개. 각 테마마다 근거 종목과 기관 수, 해석 2줄.
                ## 5. 매크로와의 연결
                현재 금리·유동성·섹터 모멘텀 데이터와 테마가 맞는지 엇갈리는지 3~4줄.
                ## 6. 한계와 다음 분기 확인 사항
                목록 3~5줄.
                """);
        return prompts;
    }
}
