#!/usr/bin/env dotnet-script
#nullable enable
// render-dashboard.csx — offline HTML trend dashboard rendered from a metrics JSON (schema v1 or v2, from session-metrics.csx).
//
// USAGE:
//   dotnet script render-dashboard.csx <metrics.json> --out <file.html> [--pricing <pricing.json>]
//       [--from yyyy-MM-dd] [--to yyyy-MM-dd] [--group all|cwd:<path>] [--focus <sessionId>]
//
// BEHAVIOUR:
//   • Buckets: one per day when the window is <= 45 days, otherwise one per ISO week (Monday start).
//   • Cost: schema v2 uses the file's costUsd (no price table); schema v1 uses the --pricing price table
//     (uncached input = input - cacheRead - cacheWrite at the input rate, cache read and write at their rates),
//     and total tokens replace it when there is no --pricing file.
//   • Inline SVG line charts: cost (USD), cache read ratio,
//     compactions per session, dispatch failure rate, repeat-dispatch rate, errors per session,
//     user turns per session.
//   • Tables: per-agent aggregates over the window; rule signals per bucket.
//   • Schema v2 only: one keep-alive and hook latency table (sums; medians of the per-session percentiles).
//   • --focus <id>: the focus session against the median and p25–p75 of the other sessions in the same group/window.
//   • Null numeric fields mean "no data": skipped in aggregates and shown as n/a, never counted as 0.
//   • Self-contained: inline CSS and SVG only, no JavaScript, no external resources; all data is HTML-encoded.
//
// EXIT CODES: 0 = written, 2 = usage error, 1 = unreadable or invalid input.

using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;

static class Dash
{
    const int MaxDailyWindowDays = 45;
    const string UsageText = "usage: dotnet script render-dashboard.csx <metrics.json> --out <file.html> [--pricing <pricing.json>] [--from yyyy-MM-dd] [--to yyyy-MM-dd] [--group all|cwd:<path>] [--focus <sessionId>]";
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    const string Css =
        "body{font-family:Segoe UI,Arial,sans-serif;margin:24px auto;max-width:900px;color:#1f2937;line-height:1.4}" +
        "h1{font-size:22px;margin-bottom:4px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}" +
        ".meta{margin:2px 0}.note{font-size:12px;color:#4b5563}.empty{font-size:16px;font-weight:600;color:#b45309}" +
        ".chart{margin:14px 0}.chart figcaption{font-weight:600;margin-bottom:2px}svg{width:100%;height:auto}" +
        ".grid{stroke:#e5e7eb}.axis{stroke:#9ca3af}.tick{font-size:11px;fill:#4b5563}" +
        ".series{stroke:#2563eb;stroke-width:2;fill:none}.pt{fill:#2563eb}.na{fill:#9ca3af}" +
        "table{border-collapse:collapse;font-size:13px;margin:8px 0}th,td{border:1px solid #e5e7eb;padding:3px 8px;text-align:right}" +
        "th:first-child,td:first-child{text-align:left}";

    public sealed class Options
    {
        public string Metrics = "";
        public string Out = "";
        public string? Pricing;
        public string Group = "all";
        public string? Focus;
        public DateTime? From;
        public DateTime? To;
    }

    public sealed class Pricing
    {
        public string Source = "";
        public string Retrieved = "";
        // model -> [input, output, cacheRead, cacheWrite] in USD per million tokens
        public Dictionary<string, double[]> Models = new(StringComparer.Ordinal);
    }

    public sealed class ModelUse
    {
        public string Model = "";
        public double? Input, Output, CacheRead, CacheWrite;
    }

    public sealed class AgentUse
    {
        public string Name = "";
        public double? Dispatches, Failures, RepeatDispatches, MedianTokens, MedianDurationMs;
    }

    public sealed class KeepAliveUse
    {
        public double? Pings, CostUsd, Chains, WastedChains;
    }

    public sealed class HookLatencyUse
    {
        public double? Count, TotalMs, P50Ms, P90Ms;
    }

    public sealed class Session
    {
        public string Id = "";
        public string Cwd = "";
        public DateTimeOffset Start;
        public double? DurationMs, UserTurns, Compactions, Errors, CacheReadRatio, Dispatches, DispatchFailures,
            RepeatDispatches, BuiltinAgentDispatches, ReadOnlyAgentWriteCalls, MainPowershellCalls;
        public List<ModelUse> Models = new();
        public List<AgentUse> Agents = new();
        public bool CostFromFields;   // schema v2: CostUsd is the file's costUsd; schema v1 prices the models
        public double? CostUsd;
        public KeepAliveUse? KeepAlive;
        public HookLatencyUse? HookLatency;
        public DateTime Day => Start.Date; // calendar date in the session's own UTC offset
    }

    public sealed class Bucket
    {
        public Bucket(string label, string shortLabel) { Label = label; Short = shortLabel; }
        public string Label;
        public string Short;
        public List<Session> Sessions = new();
    }

    public sealed record Row(string Name, Func<Session, double?> Get, Func<double?, string> Fmt);

    public static int Execute(IList<string> args)
    {
        var o = new Options();
        var positional = new List<string>();
        for (int i = 0; i < args.Count; i++)
        {
            var a = args[i];
            if (!a.StartsWith("--", StringComparison.Ordinal)) { positional.Add(a); continue; }
            if (i + 1 >= args.Count || args[i + 1].StartsWith("--", StringComparison.Ordinal))
                return Usage($"missing value for {a}");
            var v = args[++i];
            switch (a)
            {
                case "--out": o.Out = v; break;
                case "--pricing": o.Pricing = v; break;
                case "--group": o.Group = v; break;
                case "--focus": o.Focus = v; break;
                case "--from":
                    if (!TryDate(v, out var fromDate)) return Usage($"--from must be yyyy-MM-dd (got '{v}')");
                    o.From = fromDate; break;
                case "--to":
                    if (!TryDate(v, out var toDate)) return Usage($"--to must be yyyy-MM-dd (got '{v}')");
                    o.To = toDate; break;
                default: return Usage($"unknown option {a}");
            }
        }
        if (positional.Count != 1) return Usage("exactly one metrics.json path is required");
        if (string.IsNullOrWhiteSpace(o.Out)) return Usage("--out <file.html> is required");
        if (o.Group != "all" && !o.Group.StartsWith("cwd:", StringComparison.Ordinal))
            return Usage("--group must be 'all' or 'cwd:<path>'");
        if (o.From > o.To) return Usage("--from must not be after --to");
        o.Metrics = positional[0];
        try
        {
            return Render(o);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"render-dashboard: {ex.Message}");
            return 1;
        }
    }

    static int Usage(string message)
    {
        Console.Error.WriteLine($"render-dashboard: {message}");
        Console.Error.WriteLine(UsageText);
        return 2;
    }

    static int Render(Options o)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.GetFullPath(o.Metrics)));
        var root = doc.RootElement;
        bool v2 = Num(root, "schemaVersion") >= 2; // schema v2 carries its own cost fields
        var sessions = Arr(root, "sessions").Select(s => ParseSession(s, v2)).ToList();
        int skippedCount = Arr(root, "skipped").Count();
        string sourceText = Str(root, "source") ?? "n/a";
        string generatedAt = Str(root, "generatedAt") ?? "n/a";
        // The price table is read only for schema v1; schema v2 costs come from the file.
        Pricing? pricing = o.Pricing is null || v2 ? null : LoadPricing(Path.GetFullPath(o.Pricing));
        bool costShown = v2 || pricing is not null;

        var inWindow = sessions
            .Where(s => GroupMatches(s, o.Group))
            .Where(s => (o.From is null || s.Day >= o.From) && (o.To is null || s.Day <= o.To))
            .OrderBy(s => s.Start)
            .ToList();
        DateTime? winFrom = o.From ?? (inWindow.Count > 0 ? inWindow.Min(s => s.Day) : (DateTime?)null);
        DateTime? winTo = o.To ?? (inWindow.Count > 0 ? inWindow.Max(s => s.Day) : (DateTime?)null);

        var notes = new List<string>();
        if (v2 && o.Pricing is not null) notes.Add("--pricing is ignored: schema v2 files carry their own cost (costUsd).");
        if (!costShown) notes.Add("No --pricing file given: the cost series is replaced by total tokens.");
        if (skippedCount > 0) notes.Add($"{skippedCount} session(s) listed as skipped in the metrics file are not rendered.");
        int noModelData = inWindow.Count(s => s.Models.Count == 0);
        if (noModelData > 0)
            notes.Add(v2
                ? $"{noModelData} of {inWindow.Count} session(s) in the window have no model data; their token values are n/a and are left out of token sums and baseline statistics."
                : $"{noModelData} of {inWindow.Count} session(s) in the window have no model data; their cost and token values are n/a and are left out of sums and baseline statistics.");
        int sessionsWithoutCost = v2 ? inWindow.Count(s => s.CostUsd is null) : 0;
        if (sessionsWithoutCost > 0)
            notes.Add($"{sessionsWithoutCost} of {inWindow.Count} session(s) in the window have no cost (schema v2 costUsd is null); their cost is n/a and they are left out of cost sums and baseline statistics.");

        var body = new StringBuilder();
        string windowText = $"{DateText(winFrom)} to {DateText(winTo)}";
        if (inWindow.Count == 0)
        {
            body.Append("<p class=\"empty\">No sessions in window.</p>");
        }
        else
        {
            DateTime from = winFrom!.Value, to = winTo!.Value;
            bool daily = (to - from).Days + 1 <= MaxDailyWindowDays;
            DateTime origin = daily ? from : Monday(from);
            var buckets = MakeBuckets(origin, to, daily);
            foreach (var s in inWindow)
                buckets[daily ? (s.Day - origin).Days : (Monday(s.Day) - origin).Days / 7].Sessions.Add(s);
            windowText += $" ({(to - from).Days + 1} day(s), {(daily ? "one bucket per day" : "one bucket per ISO week")})";

            body.Append("<h2>Trends</h2>");
            body.Append($"<p class=\"note\">{buckets.Count} bucket(s). Hover a point for its value. Grey dot = no data in that bucket (n/a).</p>");
            body.Append(Charts(buckets, pricing, costShown, notes));
            if (v2) body.Append(KeepAliveSection(inWindow));
            if (o.Focus is not null) body.Append(FocusSection(o.Focus, inWindow, pricing, costShown, notes));
            body.Append("<h2>Per-agent aggregates</h2>");
            body.Append("<p class=\"note\">Failure and repeat rates are pooled (sum of failures / sum of dispatches). Median tokens and duration are medians of the per-session agent medians.</p>");
            body.Append(AgentTable(inWindow));
            body.Append("<h2>Rule signals per bucket</h2>");
            body.Append("<p class=\"note\">Sums over the sessions in each bucket; n/a when every session has no data.</p>");
            body.Append(SignalsTable(buckets));
        }

        var page = new StringBuilder();
        page.Append("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
        page.Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Workflow dashboard</title>\n");
        page.Append("<style>").Append(Css).Append("</style>\n</head>\n<body>\n<header>\n<h1>Workflow dashboard</h1>\n");
        page.Append($"<p class=\"meta\">Window: {Enc(windowText)}</p>\n");
        page.Append($"<p class=\"meta\">Group: {Enc(o.Group)}</p>\n");
        page.Append($"<p class=\"meta\">Sessions: {inWindow.Count}</p>\n");
        page.Append(v2 ? "<p class=\"meta\">Cost source: schema v2 cost fields (costUsd)</p>\n"
            : pricing is null ? "<p class=\"meta\">Pricing: none (total tokens are shown instead of cost)</p>\n"
            : $"<p class=\"meta\">Pricing: {Enc(pricing.Source)} (retrieved {Enc(pricing.Retrieved)})</p>\n");
        page.Append($"<p class=\"meta\">Source: {Enc(sourceText)} | generated {Enc(generatedAt)}</p>\n</header>\n");
        if (notes.Count > 0)
        {
            page.Append("<section>\n<h2>Notes</h2>\n<ul>\n");
            foreach (var n in notes.Distinct()) page.Append($"<li>{Enc(n)}</li>\n");
            page.Append("</ul>\n</section>\n");
        }
        page.Append(body);
        page.Append("</body>\n</html>\n");

        var outPath = Path.GetFullPath(o.Out);
        Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
        File.WriteAllText(outPath, page.ToString(), new UTF8Encoding(false));
        Console.Error.WriteLine($"Wrote dashboard -> {outPath}");
        return 0;
    }

    // ── charts ───────────────────────────────────────────────────────────────

    static string Charts(IReadOnlyList<Bucket> buckets, Pricing? pricing, bool costShown, List<string> notes)
    {
        var sb = new StringBuilder();
        if (!costShown)
            sb.Append(Chart("Total tokens per bucket", "Sum of input (cache read and write included) and output tokens of the sessions in each bucket.",
                buckets, Series(buckets, ss => SumOrNull(ss.Select(SessionTokens))), v => v.ToString("N0", Inv), false));
        else
            sb.Append(Chart("Cost per bucket (USD)", "Sum of per-session cost (schema v2 costUsd, or the price table for schema v1). Sessions with unknown cost or unpriced models are left out (see notes); n/a = no known cost in the bucket.",
                buckets, Series(buckets, ss => SumOrNull(ss.Select(s => SessionCost(s, pricing, notes)))), v => "$" + v.ToString("0.00", Inv), false));
        sb.Append(Chart("Cache read ratio", "Mean of the per-session cache read ratio, shown as %.",
            buckets, Series(buckets, ss => Mean(ss.Select(s => s.CacheReadRatio))), Pct, true));
        sb.Append(Chart("Compactions per session", "Mean compactions per session.",
            buckets, Series(buckets, ss => Mean(ss.Select(s => s.Compactions))), v => v.ToString("0.##", Inv), false));
        sb.Append(Chart("Dispatch failure rate", "Failed dispatches / dispatches, pooled over sessions with at least one dispatch.",
            buckets, Series(buckets, ss => PooledRate(ss.Select(s => (s.DispatchFailures, s.Dispatches)))), Pct, true));
        sb.Append(Chart("Repeat-dispatch rate", "Repeat dispatches / dispatches, pooled over sessions with at least one dispatch.",
            buckets, Series(buckets, ss => PooledRate(ss.Select(s => (s.RepeatDispatches, s.Dispatches)))), Pct, true));
        sb.Append(Chart("Errors per session", "Mean errors per session.",
            buckets, Series(buckets, ss => Mean(ss.Select(s => s.Errors))), v => v.ToString("0.##", Inv), false));
        sb.Append(Chart("User turns per session", "Mean user turns per session.",
            buckets, Series(buckets, ss => Mean(ss.Select(s => s.UserTurns))), v => v.ToString("0.##", Inv), false));
        return sb.ToString();
    }

    static double?[] Series(IReadOnlyList<Bucket> buckets, Func<List<Session>, double?> f) =>
        buckets.Select(b => f(b.Sessions)).ToArray();

    static string Chart(string title, string note, IReadOnlyList<Bucket> buckets, double?[] values, Func<double, string> fmt, bool percent)
    {
        const double W = 760, H = 230, L = 64, R = 16, T = 14, B = 46;
        double plotW = W - L - R, plotH = H - T - B, bottom = T + plotH;
        var known = values.Where(v => v.HasValue).Select(v => v!.Value).ToList();
        double max = known.Count > 0 ? known.Max() : 0;
        double yMax = percent ? Math.Max(1.0, max) : (max > 0 ? max * 1.1 : 1.0);
        int n = buckets.Count;
        double X(int i) => n == 1 ? L + plotW / 2 : L + plotW * i / (n - 1);
        double Y(double v) => T + plotH * (1 - v / yMax);

        var sb = new StringBuilder();
        sb.Append($"<figure class=\"chart\"><figcaption>{Enc(title)}</figcaption>");
        sb.Append($"<svg viewBox=\"0 0 {F(W)} {F(H)}\" role=\"img\" aria-label=\"{Enc(title)}\">");
        foreach (var f in new[] { 0.0, 0.5, 1.0 })
        {
            var v = yMax * f;
            sb.Append($"<line class=\"grid\" x1=\"{F(L)}\" y1=\"{F(Y(v))}\" x2=\"{F(W - R)}\" y2=\"{F(Y(v))}\"/>");
            if (known.Count > 0) // no known values: no tick labels, since a $0.00 tick would read as a value
                sb.Append($"<text class=\"tick\" x=\"{F(L - 6)}\" y=\"{F(Y(v) + 4)}\" text-anchor=\"end\">{Enc(fmt(v))}</text>");
        }
        sb.Append($"<line class=\"axis\" x1=\"{F(L)}\" y1=\"{F(T)}\" x2=\"{F(L)}\" y2=\"{F(bottom)}\"/>");
        sb.Append($"<line class=\"axis\" x1=\"{F(L)}\" y1=\"{F(bottom)}\" x2=\"{F(W - R)}\" y2=\"{F(bottom)}\"/>");
        int step = Math.Max(1, (int)Math.Ceiling(n / 10.0));
        for (int i = 0; i < n; i += step)
            sb.Append($"<text class=\"tick\" x=\"{F(X(i))}\" y=\"{F(bottom + 16)}\" text-anchor=\"middle\">{Enc(buckets[i].Short)}</text>");

        var segment = new List<string>();
        void Flush()
        {
            if (segment.Count > 1)
            {
                var points = string.Join(" ", segment);
                sb.Append($"<polyline class=\"series\" points=\"{points}\"/>");
            }
            segment.Clear();
        }
        for (int i = 0; i < n; i++)
        {
            var v = values[i];
            if (v.HasValue) segment.Add(F(X(i)) + "," + F(Y(v.Value)));
            else Flush();
        }
        Flush();

        for (int i = 0; i < n; i++)
        {
            var v = values[i];
            var label = Enc(buckets[i].Label);
            if (v.HasValue)
                sb.Append($"<circle class=\"pt\" cx=\"{F(X(i))}\" cy=\"{F(Y(v.Value))}\" r=\"3.5\"><title>{label}: {Enc(fmt(v.Value))}</title></circle>");
            else
                sb.Append($"<circle class=\"na\" cx=\"{F(X(i))}\" cy=\"{F(bottom)}\" r=\"2.5\"><title>{label}: n/a</title></circle>");
        }
        sb.Append("</svg>");
        sb.Append($"<p class=\"note\">{Enc(note)}</p></figure>");
        return sb.ToString();
    }

    // ── focus vs baseline ────────────────────────────────────────────────────

    static string FocusSection(string focusId, List<Session> inWindow, Pricing? pricing, bool costShown, List<string> notes)
    {
        var sb = new StringBuilder();
        sb.Append("<h2>Focus vs baseline</h2>");
        var focus = inWindow.FirstOrDefault(s => s.Id == focusId);
        if (focus is null)
        {
            sb.Append($"<p>Focus session {Enc(focusId)} was not found in the selected sessions.</p>");
            return sb.ToString();
        }
        var baseline = inWindow.Where(s => s != focus).ToList();
        sb.Append($"<p>Focus <b>{Enc(focus.Id)}</b> ({Enc(focus.Cwd)}, started {Enc(focus.Start.ToString("yyyy-MM-dd HH:mm zzz", Inv))}) " +
                  $"against {baseline.Count} other session(s) in the same group and window.</p>");

        var rows = new List<Row>
        {
            new Row("User turns", s => s.UserTurns, v => NumOrNa(v, "0.##")),
            new Row("Errors", s => s.Errors, v => NumOrNa(v, "0.##")),
            new Row("Compactions", s => s.Compactions, v => NumOrNa(v, "0.##")),
            new Row("Cache read ratio", s => s.CacheReadRatio, PctOrNa),
            new Row("Dispatch failure rate (per session)", s => Ratio(s.DispatchFailures, s.Dispatches), PctOrNa),
            new Row("Repeat-dispatch rate (per session)", s => Ratio(s.RepeatDispatches, s.Dispatches), PctOrNa),
            new Row("Duration (min)", s => Div(s.DurationMs, 60000.0), v => NumOrNa(v, "0.##")),
        };
        if (costShown)
            rows.Add(new Row("Cost (USD)", s => SessionCost(s, pricing, notes), v => NumOrNa(v, "0.0000")));
        rows.Add(new Row("Total tokens", SessionTokens, v => NumOrNa(v, "N0")));

        sb.Append("<table><thead><tr><th>Metric</th><th>Focus</th><th>Baseline median</th><th>Baseline p25</th><th>Baseline p75</th><th>n</th></tr></thead><tbody>");
        foreach (var row in rows)
        {
            var values = baseline.Select(row.Get).ToList();
            int n = values.Count(v => v.HasValue);
            sb.Append($"<tr><td>{Enc(row.Name)}</td><td>{Enc(row.Fmt(row.Get(focus)))}</td>" +
                      $"<td>{Enc(row.Fmt(Quantile(values, 0.5)))}</td><td>{Enc(row.Fmt(Quantile(values, 0.25)))}</td>" +
                      $"<td>{Enc(row.Fmt(Quantile(values, 0.75)))}</td><td>{n}</td></tr>");
        }
        sb.Append("</tbody></table>");
        sb.Append("<p class=\"note\">Legend: median = middle value of the baseline; p25 and p75 = 25th and 75th percentiles " +
                  "(linear interpolation), so p25–p75 is the middle half of the baseline. n = baseline sessions with data. " +
                  "n/a = no data; null source fields are left out of the baseline, never counted as 0.</p>");
        return sb.ToString();
    }

    // ── tables ───────────────────────────────────────────────────────────────

    // Schema v2 only: keep-alive and hook latency over the sessions with data (sums; medians of per-session percentiles).
    static string KeepAliveSection(List<Session> sessions)
    {
        var keepAlives = sessions.Select(s => s.KeepAlive).ToList();
        var hookLatencies = sessions.Select(s => s.HookLatency).ToList();
        var pings = keepAlives.Select(k => k?.Pings).ToList();
        var costs = keepAlives.Select(k => k?.CostUsd).ToList();
        var chains = keepAlives.Select(k => k?.Chains).ToList();
        var wastedChains = keepAlives.Select(k => k?.WastedChains).ToList();
        var hookWindows = hookLatencies.Select(h => h?.Count).ToList();
        var hookTotals = hookLatencies.Select(h => h?.TotalMs).ToList();
        var hookP50s = hookLatencies.Select(h => h?.P50Ms).ToList();
        var hookP90s = hookLatencies.Select(h => h?.P90Ms).ToList();

        var sb = new StringBuilder();
        sb.Append("<h2>Keep-alive and hook latency</h2>");
        sb.Append("<p class=\"note\">Sums over the sessions with data; hook percentiles are medians of the per-session values. n = sessions with data for that row.</p>");
        sb.Append("<table><thead><tr><th>Metric</th><th>Value</th><th>n</th></tr></thead><tbody>");
        AddSummaryRow(sb, "Keep-alive pings", SumOrNull(pings), v => NumOrNa(v, "0.##"), pings);
        AddSummaryRow(sb, "Keep-alive cost", SumOrNull(costs), UsdOrNa, costs);
        AddSummaryRow(sb, "Keep-alive chains", SumOrNull(chains), v => NumOrNa(v, "0.##"), chains);
        AddSummaryRow(sb, "Wasted chains", SumOrNull(wastedChains), v => NumOrNa(v, "0.##"), wastedChains);
        AddSummaryRow(sb, "Wasted chain share", PooledRate(keepAlives.Select(k => (k?.WastedChains, k?.Chains))), PctOrNa, chains);
        AddSummaryRow(sb, "Hook windows", SumOrNull(hookWindows), v => NumOrNa(v, "0.##"), hookWindows);
        AddSummaryRow(sb, "Hook latency total", SumOrNull(hookTotals), SecOrNa, hookTotals);
        AddSummaryRow(sb, "Hook p50, median of sessions", Quantile(hookP50s, 0.5), MsOrNa, hookP50s);
        AddSummaryRow(sb, "Hook p90, median of sessions", Quantile(hookP90s, 0.5), MsOrNa, hookP90s);
        sb.Append("</tbody></table>");
        return sb.ToString();
    }

    static void AddSummaryRow(StringBuilder sb, string name, double? value, Func<double?, string> fmt, IEnumerable<double?> inputs)
    {
        int n = inputs.Count(v => v.HasValue);
        sb.Append($"<tr><td>{Enc(name)}</td><td>{Enc(fmt(value))}</td><td>{n}</td></tr>");
    }

    static string AgentTable(List<Session> sessions)
    {
        var sb = new StringBuilder();
        sb.Append("<table><thead><tr><th>Agent</th><th>Sessions</th><th>Dispatches</th><th>Failure rate</th>" +
                  "<th>Repeat rate</th><th>Median tokens</th><th>Median duration</th></tr></thead><tbody>");
        var entries = sessions.SelectMany(s => s.Agents.Select(a => (S: s, A: a))).ToList();
        foreach (var g in entries.GroupBy(e => e.A.Name, StringComparer.Ordinal).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var list = g.ToList();
            int sessionCount = list.Select(e => e.S.Id).Distinct().Count();
            var dispatches = SumOrNull(list.Select(e => e.A.Dispatches));
            var failureRate = PooledRate(list.Select(e => (e.A.Failures, e.A.Dispatches)));
            var repeatRate = PooledRate(list.Select(e => (e.A.RepeatDispatches, e.A.Dispatches)));
            var medianTokens = Quantile(list.Select(e => e.A.MedianTokens), 0.5);
            var medianDuration = Quantile(list.Select(e => e.A.MedianDurationMs), 0.5);
            sb.Append($"<tr><td>{Enc(g.Key)}</td><td>{sessionCount}</td><td>{NumOrNa(dispatches, "0.##")}</td>" +
                      $"<td>{PctOrNa(failureRate)}</td><td>{PctOrNa(repeatRate)}</td>" +
                      $"<td>{NumOrNa(medianTokens, "N0")}</td><td>{SecOrNa(medianDuration)}</td></tr>");
        }
        sb.Append("</tbody></table>");
        if (entries.Count == 0) sb.Append("<p class=\"note\">No agent dispatches in this window.</p>");
        return sb.ToString();
    }

    static string SignalsTable(IReadOnlyList<Bucket> buckets)
    {
        var sb = new StringBuilder();
        sb.Append("<table><thead><tr><th>Bucket</th><th>Sessions</th><th>builtinAgentDispatches</th>" +
                  "<th>readOnlyAgentWriteCalls</th><th>mainPowershellCalls</th></tr></thead><tbody>");
        foreach (var b in buckets)
        {
            sb.Append($"<tr><td>{Enc(b.Label)}</td><td>{b.Sessions.Count}</td>" +
                      $"<td>{NumOrNa(SumOrNull(b.Sessions.Select(s => s.BuiltinAgentDispatches)), "0.##")}</td>" +
                      $"<td>{NumOrNa(SumOrNull(b.Sessions.Select(s => s.ReadOnlyAgentWriteCalls)), "0.##")}</td>" +
                      $"<td>{NumOrNa(SumOrNull(b.Sessions.Select(s => s.MainPowershellCalls)), "0.##")}</td></tr>");
        }
        sb.Append("</tbody></table>");
        return sb.ToString();
    }

    // ── metrics arithmetic (null = no data) ──────────────────────────────────

    // Schema v2: the file's costUsd, null when the file has none (never a price-table value).
    // Schema v1: price table over the models; a session without model data (models: []) has no cost: null, never 0.
    static double? SessionCost(Session s, Pricing? pricing, List<string> notes)
    {
        if (s.CostFromFields) return s.CostUsd;
        if (s.Models.Count == 0) return null;
        if (pricing is null) return null;
        double total = 0;
        int priced = 0;
        foreach (var m in s.Models)
        {
            if (!pricing.Models.TryGetValue(m.Model, out var r))
            {
                notes.Add($"Unpriced model excluded from cost: {m.Model} ({s.Id})");
                continue;
            }
            if (m.Input is null || m.Output is null || m.CacheRead is null || m.CacheWrite is null)
            {
                notes.Add($"Model with null token fields excluded from cost: {m.Model} ({s.Id})");
                continue;
            }
            // inputTokens already includes cacheReadTokens and cacheWriteTokens: only the uncached part is billed at the input rate.
            var uncachedInput = Math.Max(0, m.Input.Value - m.CacheRead.Value - m.CacheWrite.Value);
            total += (uncachedInput * r[0] + m.Output.Value * r[1] + m.CacheRead.Value * r[2] + m.CacheWrite.Value * r[3]) / 1_000_000.0;
            priced++;
        }
        return priced == 0 ? null : total;
    }

    // inputTokens already includes the cache tokens (usage-records.csx), so only input and output are summed.
    static double? SessionTokens(Session s)
    {
        if (s.Models.Count == 0) return null;
        double total = 0;
        bool any = false;
        foreach (var m in s.Models)
            foreach (var v in new[] { m.Input, m.Output })
                if (v.HasValue) { total += v.Value; any = true; }
        return any ? total : null;
    }

    static double? Ratio(double? num, double? den) =>
        num.HasValue && den.HasValue && den.Value > 0 ? num.Value / den.Value : null;

    static double? Div(double? a, double b) => a.HasValue ? a.Value / b : null;

    static double? PooledRate(IEnumerable<(double? num, double? den)> pairs)
    {
        double n = 0, d = 0;
        bool any = false;
        foreach (var (num, den) in pairs)
            if (num.HasValue && den.HasValue && den.Value > 0) { n += num.Value; d += den.Value; any = true; }
        return any ? n / d : null;
    }

    static double? Mean(IEnumerable<double?> xs)
    {
        var v = xs.Where(x => x.HasValue).Select(x => x!.Value).ToList();
        return v.Count == 0 ? null : v.Average();
    }

    static double? SumOrNull(IEnumerable<double?> xs)
    {
        var v = xs.Where(x => x.HasValue).Select(x => x!.Value).ToList();
        return v.Count == 0 ? null : v.Sum();
    }

    // Linear-interpolation quantile (type 7). Returns null when there is no data.
    static double? Quantile(IEnumerable<double?> values, double q)
    {
        var xs = values.Where(v => v.HasValue).Select(v => v!.Value).OrderBy(v => v).ToList();
        if (xs.Count == 0) return null;
        double h = (xs.Count - 1) * q;
        int lo = (int)Math.Floor(h);
        int hi = Math.Min(lo + 1, xs.Count - 1);
        return xs[lo] + (h - lo) * (xs[hi] - xs[lo]);
    }

    // ── input parsing ────────────────────────────────────────────────────────

    static bool GroupMatches(Session s, string group) =>
        group == "all" || string.Equals(s.Cwd, group.Substring(4), StringComparison.OrdinalIgnoreCase);

    static Session ParseSession(JsonElement e, bool v2)
    {
        var id = Str(e, "sessionId") ?? "(no id)";
        var startText = Str(e, "startTime") ?? throw new FormatException($"session {id}: startTime is missing");
        var s = new Session
        {
            Id = id,
            Cwd = Str(e, "cwd") ?? "",
            Start = DateTimeOffset.Parse(startText, Inv, DateTimeStyles.None),
            DurationMs = Num(e, "durationMs"),
            UserTurns = Num(e, "userTurns"),
            Compactions = Num(e, "compactions"),
            Errors = Num(e, "errors"),
            CacheReadRatio = Num(e, "cacheReadRatio"),
            Dispatches = Num(e, "dispatches"),
            DispatchFailures = Num(e, "dispatchFailures"),
            RepeatDispatches = Num(e, "repeatDispatches"),
            BuiltinAgentDispatches = Num(e, "builtinAgentDispatches"),
            ReadOnlyAgentWriteCalls = Num(e, "readOnlyAgentWriteCalls"),
            MainPowershellCalls = Num(e, "mainPowershellCalls"),
            CostFromFields = v2,
            CostUsd = v2 ? Num(e, "costUsd") : null,
            KeepAlive = v2 ? KeepAliveOf(e) : null,
            HookLatency = v2 ? HookLatencyOf(e) : null,
        };
        foreach (var m in Arr(e, "models"))
            s.Models.Add(new ModelUse
            {
                Model = Str(m, "model") ?? "(unknown)",
                Input = Num(m, "inputTokens"),
                Output = Num(m, "outputTokens"),
                CacheRead = Num(m, "cacheReadTokens"),
                CacheWrite = Num(m, "cacheWriteTokens"),
            });
        foreach (var a in Arr(e, "agents"))
            s.Agents.Add(new AgentUse
            {
                Name = Str(a, "agentName") ?? "(unknown)",
                Dispatches = Num(a, "dispatches"),
                Failures = Num(a, "failures"),
                RepeatDispatches = Num(a, "repeatDispatches"),
                MedianTokens = Num(a, "medianTokens"),
                MedianDurationMs = Num(a, "medianDurationMs"),
            });
        return s;
    }

    static KeepAliveUse? KeepAliveOf(JsonElement e)
    {
        var k = Child(e, "keepAlive");
        if (k.ValueKind != JsonValueKind.Object) return null;
        return new KeepAliveUse { Pings = Num(k, "pings"), CostUsd = Num(k, "costUsd"), Chains = Num(k, "chains"), WastedChains = Num(k, "wastedChains") };
    }

    static HookLatencyUse? HookLatencyOf(JsonElement e)
    {
        var h = Child(e, "hookLatency");
        if (h.ValueKind != JsonValueKind.Object) return null;
        return new HookLatencyUse { Count = Num(h, "count"), TotalMs = Num(h, "totalMs"), P50Ms = Num(h, "p50Ms"), P90Ms = Num(h, "p90Ms") };
    }

    static JsonElement Child(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

    static Pricing LoadPricing(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var r = doc.RootElement;
        var p = new Pricing { Source = Str(r, "source") ?? "(unnamed)", Retrieved = Str(r, "retrieved") ?? "n/a" };
        if (r.ValueKind == JsonValueKind.Object && r.TryGetProperty("models", out var models) && models.ValueKind == JsonValueKind.Object)
        {
            foreach (var m in models.EnumerateObject())
            {
                var rates = new[] { Num(m.Value, "input"), Num(m.Value, "output"), Num(m.Value, "cacheRead"), Num(m.Value, "cacheWrite") };
                if (rates.All(x => x.HasValue)) p.Models[m.Name] = rates.Select(x => x!.Value).ToArray();
            }
        }
        return p;
    }

    static IEnumerable<JsonElement> Arr(JsonElement e, string name)
    {
        if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array)
            return v.EnumerateArray();
        return Array.Empty<JsonElement>();
    }

    static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    static double? Num(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    // ── formatting & dates ───────────────────────────────────────────────────

    static bool TryDate(string text, out DateTime d) =>
        DateTime.TryParseExact(text, "yyyy-MM-dd", Inv, DateTimeStyles.None, out d);

    static DateTime Monday(DateTime d) => d.AddDays(-(((int)d.DayOfWeek + 6) % 7));

    static List<Bucket> MakeBuckets(DateTime origin, DateTime to, bool daily)
    {
        var list = new List<Bucket>();
        for (var d = origin; d <= to; d = daily ? d.AddDays(1) : d.AddDays(7))
        {
            var iso = d.ToString("yyyy-MM-dd", Inv);
            list.Add(new Bucket(daily ? iso : "week of " + iso, d.ToString("MM-dd", Inv)));
        }
        return list;
    }

    static string DateText(DateTime? d) => d.HasValue ? d.Value.ToString("yyyy-MM-dd", Inv) : "n/a";
    static string F(double v) => v.ToString("0.##", Inv);
    static string Pct(double v) => (v * 100).ToString("0.0", Inv) + "%";
    static string PctOrNa(double? v) => v.HasValue ? Pct(v.Value) : "n/a";
    static string NumOrNa(double? v, string format) => v.HasValue ? v.Value.ToString(format, Inv) : "n/a";
    static string SecOrNa(double? ms) => ms.HasValue ? (ms.Value / 1000.0).ToString("0.0", Inv) + " s" : "n/a";
    static string MsOrNa(double? ms) => ms.HasValue ? ms.Value.ToString("0", Inv) + " ms" : "n/a";
    static string UsdOrNa(double? usd) => usd.HasValue ? "$" + usd.Value.ToString("0.00", Inv) : "n/a";

    // HTML-encode all data text; also neutralise "://" so no URL can appear even from data.
    static string Enc(string? s) => WebUtility.HtmlEncode(s ?? "").Replace("://", ":&#47;&#47;", StringComparison.Ordinal);
}

Environment.Exit(Dash.Execute(Args));
