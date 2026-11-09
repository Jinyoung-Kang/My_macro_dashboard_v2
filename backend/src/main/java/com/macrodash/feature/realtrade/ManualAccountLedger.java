package com.macrodash.feature.realtrade;

import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.LedgerRow;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * ISA 계좌 장부의 순수 계산(ADR 0029 — 명세 docs/specs/2026-11-06-isa-manual-account.md §1) — 장부 행을 받아 현금·보유·평단·순입금을 셉니다. DB·시계를
 * 모릅니다(시험이 사례로 고정).
 *
 * <ul>
 *   <li>현금 = Σ입금 − Σ출금 − Σ매수(수량 × 체결가 + 수수료 + 세금) + Σ매도(수량 × 체결가 − 수수료 − 세금). 조정(ADJUST)은 현금을 바꾸지 않습니다.</li>
 *   <li>보유 = 종목별 Σ매수 수량 − Σ매도 수량 + Σ조정 수량. 평단은 이동평균(체결가 기준 — 수수료·세금 제외): 매수는 원가를 더하고, 매도는 평단 그대로 원가를
 *       줄이고, 조정은 원가를 두고 수량만 바꿉니다(분할이면 평단이 내려감).</li>
 *   <li>행 순서는 시각 → 같은 시각이면 입금·매도·조정·매수·출금 → 번호(새 행은 맨 뒤)입니다. 이 순서로 한 행씩 쌓을 때 <b>어느 시점에서든</b> 현금이나
 *       보유가 음수가 되면 그 장부는 받지 않습니다({@link #firstInvalid}).</li>
 * </ul>
 */
final class ManualAccountLedger {

    private ManualAccountLedger() {
    }

    /** 장부 계산이 보는 한 행 — 번호(새 행은 null — 같은 시각·같은 종류 안에서 맨 뒤). */
    record Entry(Long id, Instant at, String kind, String symbol, BigDecimal quantity, BigDecimal price, BigDecimal amount, BigDecimal fee,
                 BigDecimal tax) {

        static Entry of(LedgerRow row) {
            return new Entry(row.id(), row.at(), row.kind(), row.symbol(), row.quantity(), row.price(), row.amount(), row.fee(), row.tax());
        }

        /** 이 행이 바꾸는 현금(입금·매도는 +, 출금·매수는 −, 조정은 0). */
        BigDecimal cashDelta() {
            return switch (kind) {
                case ManualAccountStore.KIND_DEPOSIT -> nz(amount);
                case ManualAccountStore.KIND_WITHDRAW -> nz(amount).negate();
                case ManualAccountStore.KIND_BUY -> nz(quantity).multiply(nz(price)).add(nz(fee)).add(nz(tax)).negate();
                case ManualAccountStore.KIND_SELL -> nz(quantity).multiply(nz(price)).subtract(nz(fee)).subtract(nz(tax));
                default -> BigDecimal.ZERO;
            };
        }

        /** 이 행이 바꾸는 그 종목 수량(매수 +, 매도 −, 조정은 부호 그대로). 종목이 없는 행은 0. */
        BigDecimal quantityDelta() {
            return switch (kind) {
                case ManualAccountStore.KIND_BUY, ManualAccountStore.KIND_ADJUST -> nz(quantity);
                case ManualAccountStore.KIND_SELL -> nz(quantity).negate();
                default -> BigDecimal.ZERO;
            };
        }
    }

    /** 종목 하나의 보유 — 수량과 원가(체결가 기준). */
    record Holding(String symbol, BigDecimal quantity, BigDecimal cost) {

        /** 평단(원가 ÷ 수량, 소수 넷째 자리) — 수량이 0 이하이면 null. */
        BigDecimal avgPrice() {
            if (quantity.signum() <= 0) {
                return null;
            }
            return cost.divide(quantity, 4, RoundingMode.HALF_UP);
        }
    }

    /**
     * 장부를 끝까지 쌓은 상태. {@code holdings}는 수량이 0이 아닌 종목만(종목 순), {@code netDeposit}은 Σ입금 − Σ출금.
     */
    record State(BigDecimal cash, Map<String, Holding> holdings, BigDecimal netDeposit, BigDecimal deposits, BigDecimal withdrawals) {

        BigDecimal held(String symbol) {
            Holding h = holdings.get(symbol);
            return h == null ? BigDecimal.ZERO : h.quantity();
        }
    }

    /** 같은 시각 안 순서(입금 먼저 — 시작 현금으로 시작 매수를 덮게, 매도는 매수 앞 — 매도 대금으로 매수). */
    static int rank(String kind) {
        return switch (kind) {
            case ManualAccountStore.KIND_DEPOSIT -> 0;
            case ManualAccountStore.KIND_SELL -> 1;
            case ManualAccountStore.KIND_ADJUST -> 2;
            case ManualAccountStore.KIND_BUY -> 3;
            case ManualAccountStore.KIND_WITHDRAW -> 4;
            default -> 5;
        };
    }

    static final Comparator<Entry> ORDER = Comparator.comparing(Entry::at).thenComparingInt(e -> rank(e.kind()))
            .thenComparing(e -> e.id() == null ? Long.MAX_VALUE : e.id());

    /** 행을 장부 순서로 정렬한 새 목록. */
    static List<Entry> sorted(List<Entry> entries) {
        List<Entry> out = new ArrayList<>(entries);
        out.sort(ORDER);
        return out;
    }

    /** 장부를 끝까지 쌓은 상태(음수 검사 없이 — 검사는 {@link #firstInvalid}). */
    static State replay(List<Entry> entries) {
        BigDecimal cash = BigDecimal.ZERO;
        BigDecimal deposits = BigDecimal.ZERO;
        BigDecimal withdrawals = BigDecimal.ZERO;
        Map<String, BigDecimal> quantity = new TreeMap<>();
        Map<String, BigDecimal> cost = new TreeMap<>();
        for (Entry e : sorted(entries)) {
            cash = cash.add(e.cashDelta());
            if (ManualAccountStore.KIND_DEPOSIT.equals(e.kind())) {
                deposits = deposits.add(nz(e.amount()));
            } else if (ManualAccountStore.KIND_WITHDRAW.equals(e.kind())) {
                withdrawals = withdrawals.add(nz(e.amount()));
            }
            if (e.symbol() == null || e.quantityDelta().signum() == 0) {
                continue;
            }
            BigDecimal before = quantity.getOrDefault(e.symbol(), BigDecimal.ZERO);
            BigDecimal beforeCost = cost.getOrDefault(e.symbol(), BigDecimal.ZERO);
            BigDecimal after = before.add(e.quantityDelta());
            quantity.put(e.symbol(), after);
            cost.put(e.symbol(), costAfter(e, before, beforeCost, after));
        }
        Map<String, Holding> holdings = new TreeMap<>();
        quantity.forEach((symbol, q) -> {
            if (q.signum() != 0) {
                holdings.put(symbol, new Holding(symbol, q, cost.getOrDefault(symbol, BigDecimal.ZERO)));
            }
        });
        return new State(cash, holdings, deposits.subtract(withdrawals), deposits, withdrawals);
    }

    /** 이 행을 지난 뒤의 그 종목 원가(체결가 기준) — 매수는 더하고, 매도는 평단대로 줄이고, 조정은 수량만 바꿉니다(클래스 설명). */
    private static BigDecimal costAfter(Entry e, BigDecimal before, BigDecimal beforeCost, BigDecimal after) {
        if (ManualAccountStore.KIND_BUY.equals(e.kind())) {
            return beforeCost.add(nz(e.quantity()).multiply(nz(e.price())));
        }
        if (ManualAccountStore.KIND_SELL.equals(e.kind())) {
            return before.signum() > 0 ? beforeCost.multiply(after.max(BigDecimal.ZERO)).divide(before, 8, RoundingMode.HALF_UP) : BigDecimal.ZERO;
        }
        return after.signum() > 0 ? beforeCost : BigDecimal.ZERO;
    }

    /**
     * 매도 행의 실현 손익률(%) — 행 번호 → (체결가 ÷ 팔기 직전 평단 − 1) × 100, 소수 둘째 자리(2026-11-09 사용자 요청 — 장부의 종목별 손익 %). 평단과 같이
     * 체결가 기준이라 수수료·세금은 빼지 않습니다. 평단을 모르는 매도(보유·원가가 0 이하)는 결과에 없습니다(0으로 채우지 않음).
     */
    static Map<Long, BigDecimal> realizedPct(List<Entry> entries) {
        Map<String, BigDecimal> quantity = new TreeMap<>();
        Map<String, BigDecimal> cost = new TreeMap<>();
        Map<Long, BigDecimal> out = new TreeMap<>();
        for (Entry e : sorted(entries)) {
            if (e.symbol() == null || e.quantityDelta().signum() == 0) {
                continue;
            }
            BigDecimal before = quantity.getOrDefault(e.symbol(), BigDecimal.ZERO);
            BigDecimal beforeCost = cost.getOrDefault(e.symbol(), BigDecimal.ZERO);
            if (ManualAccountStore.KIND_SELL.equals(e.kind()) && e.id() != null && before.signum() > 0 && beforeCost.signum() > 0
                    && e.price() != null) {
                BigDecimal avg = beforeCost.divide(before, 12, RoundingMode.HALF_UP);
                out.put(e.id(), e.price().divide(avg, 12, RoundingMode.HALF_UP).subtract(BigDecimal.ONE).multiply(new BigDecimal("100"))
                        .setScale(2, RoundingMode.HALF_UP));
            }
            BigDecimal after = before.add(e.quantityDelta());
            quantity.put(e.symbol(), after);
            cost.put(e.symbol(), costAfter(e, before, beforeCost, after));
        }
        return out;
    }

    /**
     * 장부 순서로 한 행씩 쌓을 때 현금이나 그 종목 보유가 처음으로 음수가 되는 행 — 없으면 null(받을 수 있는 장부).
     */
    static Entry firstInvalid(List<Entry> entries) {
        BigDecimal cash = BigDecimal.ZERO;
        Map<String, BigDecimal> quantity = new TreeMap<>();
        for (Entry e : sorted(entries)) {
            cash = cash.add(e.cashDelta());
            if (cash.signum() < 0) {
                return e;
            }
            if (e.symbol() != null && e.quantityDelta().signum() != 0) {
                BigDecimal after = quantity.getOrDefault(e.symbol(), BigDecimal.ZERO).add(e.quantityDelta());
                if (after.signum() < 0) {
                    return e;
                }
                quantity.put(e.symbol(), after);
            }
        }
        return null;
    }

    /**
     * 시각 {@code at}·종류 {@code kind}에 새 행을 넣을 때 그 자리부터 끝까지의 현금 최솟값 — 새 매수가 쓸 수 있는 현금(그 뒤 어느 시점도 음수가 되지 않게).
     * 새 행은 같은 시각·같은 종류 안에서 맨 뒤에 들어갑니다.
     */
    static BigDecimal minCashFrom(List<Entry> entries, Instant at, String kind) {
        Entry probe = new Entry(null, at, kind, null, null, null, null, null, null);
        BigDecimal cash = BigDecimal.ZERO;
        BigDecimal min = null;
        for (Entry e : sorted(entries)) {
            if (min == null && ORDER.compare(e, probe) > 0) {
                min = cash;
            }
            cash = cash.add(e.cashDelta());
            if (min != null) {
                min = min.min(cash);
            }
        }
        return min == null ? cash : min;
    }

    /** 시각 {@code at}에 새 매도를 넣을 때 그 자리부터 끝까지의 그 종목 보유 최솟값 — 새 매도가 팔 수 있는 수량. */
    static BigDecimal minHoldingFrom(List<Entry> entries, String symbol, Instant at, String kind) {
        Entry probe = new Entry(null, at, kind, null, null, null, null, null, null);
        BigDecimal held = BigDecimal.ZERO;
        BigDecimal min = null;
        for (Entry e : sorted(entries)) {
            if (min == null && ORDER.compare(e, probe) > 0) {
                min = held;
            }
            if (symbol.equals(e.symbol())) {
                held = held.add(e.quantityDelta());
            }
            if (min != null) {
                min = min.min(held);
            }
        }
        return min == null ? held : min;
    }

    static BigDecimal nz(BigDecimal value) {
        return value == null ? BigDecimal.ZERO : value;
    }
}
