package com.macrodash.feature.info;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 정보 수집 출처 표(ADR 0035) — 화면 이름·분류·출처 링크. 차단 통과 수집 계층(polite)의 태스크 전부를 싣습니다(끊김 알림이 출처 이름을 씀).
 *
 * <p>블로그 줄은 수집기 {@code collector/app/services/info_blogs.py}의 {@code BLOGS}와 같아야 합니다({@code InfoSourcesParityTest}가 대조).
 */
public final class InfoSources {

    private InfoSources() {
    }

    /** 분류 — 화면의 탭. */
    public static final String BLOG = "blog";
    public static final String WAEDGE = "waedge";
    public static final String NAVER = "naver";
    public static final String CALENDAR = "calendar";

    /**
     * 출처 하나.
     *
     * @param task     수집기 태스크 이름(fetch_source_state.task)
     * @param key      info_items.source(글이 없는 출처는 스냅샷 이름 대신 쓰는 키)
     * @param siteUrl  출처 링크(화면에 그대로)
     */
    public record Source(String task, String key, String label, String category, String siteUrl) {
    }

    public static final List<Source> ALL = List.of(
            new Source("info_blog_wolfstreet", "blog.wolfstreet", "Wolf Street", BLOG, "https://wolfstreet.com/"),
            new Source("info_blog_abnormalreturns", "blog.abnormalreturns", "Abnormal Returns", BLOG, "https://abnormalreturns.com/"),
            new Source("info_blog_awealthofcommonsense", "blog.awealthofcommonsense", "A Wealth of Common Sense", BLOG,
                    "https://awealthofcommonsense.com/"),
            new Source("info_blog_marginalrevolution", "blog.marginalrevolution", "Marginal Revolution", BLOG,
                    "https://marginalrevolution.com/"),
            new Source("info_blog_ritholtz", "blog.ritholtz", "The Big Picture (Ritholtz)", BLOG, "https://ritholtz.com/"),
            new Source("info_blog_calculatedrisk", "blog.calculatedrisk", "Calculated Risk", BLOG, "https://calculatedrisk.substack.com/"),
            new Source("info_blog_libertystreet", "blog.libertystreet", "Liberty Street Economics (NY Fed)", BLOG,
                    "https://libertystreeteconomics.newyorkfed.org/"),
            new Source("info_blog_klement", "blog.klement", "Klement on Investing", BLOG, "https://klementoninvesting.substack.com/"),
            new Source("info_blog_econbrowser", "blog.econbrowser", "Econbrowser", BLOG, "https://econbrowser.com/"),
            new Source("info_blog_conversableeconomist", "blog.conversableeconomist", "Conversable Economist", BLOG,
                    "https://conversableeconomist.com/"),
            new Source("info_blog_alphaarchitect", "blog.alphaarchitect", "Alpha Architect", BLOG, "https://alphaarchitect.com/"),
            new Source("info_blog_humbledollar", "blog.humbledollar", "HumbleDollar", BLOG, "https://humbledollar.com/"),
            new Source("info_blog_damodaran", "blog.damodaran", "Musings on Markets (Damodaran)", BLOG,
                    "https://aswathdamodaran.blogspot.com/"),
            new Source("info_blog_irrelevantinvestor", "blog.irrelevantinvestor", "The Irrelevant Investor", BLOG,
                    "https://www.theirrelevantinvestor.com/"),
            new Source("info_waedge_brief", "waedge.brief", "waedge 시장", WAEDGE, "https://news.waedge.ai/s/brief.html"),
            new Source("info_waedge_people", "waedge.people", "waedge 거장", WAEDGE, "https://news.waedge.ai/s/people.html"),
            new Source("info_waedge_blogs", "waedge.blogs", "waedge 해외 블로그(한국어 제목)", WAEDGE,
                    "https://news.waedge.ai/s/blogs.html"),
            new Source("info_naver_flows", "naver.flows", "네이버 투자자별 매매동향·매매상위", NAVER,
                    "https://stock.naver.com/market/stock/kr/trend/trader"),
            new Source("econ_calendar_tradingview", "calendar.tradingview", "TradingView 경제 캘린더", CALENDAR,
                    "https://www.tradingview.com/economic-calendar/"));

    private static final Map<String, Source> BY_TASK = new LinkedHashMap<>();
    private static final Map<String, Source> BY_KEY = new LinkedHashMap<>();

    static {
        ALL.forEach(source -> {
            BY_TASK.put(source.task(), source);
            BY_KEY.put(source.key(), source);
        });
    }

    public static Optional<Source> byTask(String task) {
        return Optional.ofNullable(BY_TASK.get(task));
    }

    public static Optional<Source> byKey(String key) {
        return Optional.ofNullable(BY_KEY.get(key));
    }

    /** 태스크의 화면 이름 — 표에 없으면 태스크 이름 그대로. */
    public static String label(String task) {
        return byTask(task).map(Source::label).orElse(task);
    }

    /** 그 분류의 글 출처 키. */
    public static List<String> keysOf(String category) {
        return ALL.stream().filter(source -> source.category().equals(category)).map(Source::key).toList();
    }
}
