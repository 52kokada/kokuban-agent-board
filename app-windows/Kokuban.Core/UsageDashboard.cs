using System.Globalization;
using System.Text.Json;

namespace Kokuban.Core;

public sealed record UsageAgent(string Key, string Name, string Host, string State, string TokenText,
    string Task, string Next, string Project, string NameColor, bool Active, bool LivePresent, bool HasTodayUsage);

public sealed record UsageSnapshot(string TokenText, string HostBreakdown, string Day, string RemainingText,
    string BonusText, string BankText, string PlaybackStatus, string Metadata, int ActiveCount, IReadOnlyList<UsageAgent> Agents);

/// <summary>Pure projection of the proven read-only collectors and extension playback metadata.</summary>
public static class UsageDashboard
{
    private static readonly CultureInfo Culture = CultureInfo.GetCultureInfo("en-US");
    private const double SafeInteger = 9007199254740991;
    public static UsageSnapshot Build(string? usageJson, string? liveJson, string? playbackJson, long now)
    {
        var day = DateTimeOffset.FromUnixTimeMilliseconds(now).ToLocalTime().ToString("yyyy-MM-dd", Culture);
        using var usageDoc = Parse(usageJson);
        using var liveDoc = Parse(liveJson);
        using var playbackDoc = Parse(playbackJson);
        var usage = usageDoc?.RootElement ?? default;
        var live = liveDoc?.RootElement ?? default;
        var usageValid = Text(usage, "day") == day && Fresh(usage, "observedAt", now, 90000) && Count(usage, "totalTokens", out var tokens);
        // Validate every collector count, including hosts with no usage today.
        var hosts = Get(usage, "byHost");
        foreach (var host in new[] { "codex", "claude", "kimi" }) usageValid &= Count(hosts, host, out _);
        foreach (var row in Rows(usage, "agents")) usageValid &= Count(row, "tokens", out _);
        // Keep definite assignment independent of short-circuited validation above.
        Count(usage, "totalTokens", out tokens);
        var liveFresh = Fresh(live, "observedAt", now, 30000);
        var agents = new Dictionary<string, UsageAgent>(StringComparer.Ordinal);
        var counts = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var row in Rows(live, "sessions"))
        {
            var id = Text(row, "id"); var host = Text(row, "host"); var name = Text(row, "name");
            if (id.Length == 0 || host.Length == 0 || name.Length == 0) continue;
            var key = host + ":" + id;
            if (agents.ContainsKey(key)) continue;
            var verified = liveFresh && Bool(row, "verified") && !id.StartsWith("manual-", StringComparison.Ordinal);
            var runtime = Text(row, "state"); var work = Text(row, "work");
            var active = verified && runtime == "working";
            var present = liveFresh && (Bool(row, "present") || (verified && runtime is "working" or "idle"));
            var state = active ? "稼働中" : work == "done" ? "完了" : !verified ? "状態未確認" : runtime == "gone" ? "終了"
                : work == "waiting" ? "回答待ち" : work == "blocked" ? "対応待ち" : work == "paused" ? "一時停止" : "待機中";
            var color = active && host == "codex" ? "#FFA23A" : active && host == "claude" ? "#C69CFF" : "#E0E0E6";
            agents[key] = new(key, name, host, state, "—", Nonempty(Text(row, "doing"), "作業内容は未登録です"), Text(row, "next"), Text(row, "project"), color, active, present, false);
        }
        if (usageValid) foreach (var row in Rows(usage, "agents"))
        {
            var id = Text(row, "id"); var host = Text(row, "host");
            if (id.Length == 0 || host.Length == 0) continue;
            var key = host + ":" + id;
            if (!agents.TryGetValue(key, out var agent))
                agent = new(key, Nonempty(Text(row, "name"), host + " [" + id + "]"), host, "本日利用", "—", "現在の作業情報なし", "", "", "#E0E0E6", false, false, false);
            Count(row, "tokens", out var count);
            var sum = counts.GetValueOrDefault(key) + count;
            counts[key] = sum;
            agents[key] = agent with { HasTodayUsage = true, TokenText = sum <= SafeInteger ? Format(sum) : "—" };
        }
        var playback = Playback(playbackDoc?.RootElement ?? default, now, day);
        var metadata = new List<string> { playback.Metadata };
        metadata.Add(usageValid ? "本日の利用ログ取得済み" : usageDoc is null ? "本日の利用情報待ち" : "本日の利用情報は最終取得値または未確認（再取得待ち）");
        metadata.Add(liveFresh ? "実行状態取得済み" : liveDoc is null ? "実行状態の情報待ち" : "実行状態は最終取得値（状態未確認）");
        if (usageValid && Rows(usage, "warnings").Any()) metadata.Add("一部の記録は内訳を確認できません");
        var rows = agents.Values.OrderByDescending(a => a.Active).ThenBy(a => a.Name, StringComparer.Ordinal).ThenBy(a => a.Key, StringComparer.Ordinal).ToArray();
        var breakdown = usageValid ? string.Join("\n", new[] { "codex", "claude", "kimi" }.Select(h => { Count(hosts, h, out var c); return Culture.TextInfo.ToTitleCase(h) + "  " + Format(c); })) : "今日のログを集計しています…";
        return new(usageValid ? Format(tokens) : "—", breakdown, day, playback.Remaining, playback.Bonus, playback.Bank, playback.Status, string.Join("  ·  ", metadata), rows.Count(a => a.Active), Array.AsReadOnly(rows));
    }

    private sealed record PlaybackView(string Remaining = "—", string Bonus = "—", string Bank = "—", string Status = "YouTubeからの情報待ち", string Metadata = "拡張からの受信待ち");
    private static PlaybackView Playback(JsonElement data, long now, string day)
    {
        var unknown = new PlaybackView();
        if (!Number(data, "version", out var version) || version != 1) return unknown;
        var values = new Dictionary<string, double>();
        foreach (var field in new[] { "observedAt", "receivedAt", "remainingMs", "bankRemainingMs", "bonusTodayMs", "usedMs", "limitMinutes", "earnedTokens" })
        {
            if (!Number(data, field, out var value) || value < 0 || value > SafeInteger) return unknown;
            values[field] = value;
        }
        if (!DateOnly.TryParseExact(Text(data, "day"), "yyyy-MM-dd", Culture, DateTimeStyles.None, out _) ||
            Get(data, "generation").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            Get(data, "generationActive").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            Get(data, "generationConnected").ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return unknown;
        var generation = Bool(data, "generation"); var limit = values["limitMinutes"];
        if ((generation && limit != 0 && limit != 45) || (!generation && (limit < 1 || limit > 1440 || Math.Floor(limit) != limit))) return unknown;
        var reason = Text(data, "generationReason"); var extension = Text(data, "extensionVersion");
        if (reason is not ("" or "empty" or "daily") || string.IsNullOrWhiteSpace(extension) || extension.Length > 80) return unknown;
        if (values["observedAt"] <= 0 || values["receivedAt"] <= 0 || values["observedAt"] > now + 2000 || values["receivedAt"] > now + 2000 || values["observedAt"] > 253402300799999 || values["receivedAt"] > 253402300799999) return unknown;
        var updated = DateTimeOffset.FromUnixTimeMilliseconds((long)values["observedAt"]).ToLocalTime().ToString("MM/dd HH:mm:ss", Culture);
        var metadata = "拡張 " + extension + "  ·  更新 " + updated;
        var fresh = Text(data, "day") == day && now - values["observedAt"] <= 30000 && now - values["receivedAt"] <= 30000;
        if (!generation) return unknown with { Status = fresh ? "未有効" : "最終取得値（" + updated + "・未有効）", Metadata = metadata };
        var seconds = (long)Math.Floor(values["remainingMs"] / 1000);
        var legacyCapped = limit == 45 && values["bonusTodayMs"] >= 900000;
        var status = !fresh ? "最終取得値（" + updated + "）" : reason == "daily" ? "今日の視聴上限" : reason == "empty" ? "貯金なし" : !Bool(data, "generationConnected") ? "発電元の情報待ち" : legacyCapped ? "発電上限（旧版・拡張更新が必要）" : Bool(data, "generationActive") ? "発電中" : "発電待機中";
        return new($"{seconds / 60}分{seconds % 60:00}秒", (values["bonusTodayMs"] / 60000).ToString("N1", Culture) + (limit == 45 ? " / 15 分（旧版）" : " 分"), (values["bankRemainingMs"] / 60000).ToString("N1", Culture) + " 分", status, metadata + (limit == 45 ? "  ·  45分上限（旧版）" : "  ·  上限なし"));
    }

    private static JsonDocument? Parse(string? json) { try { return string.IsNullOrWhiteSpace(json) ? null : JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 }); } catch (JsonException) { return null; } }
    private static JsonElement Get(JsonElement data, string name) => data.ValueKind == JsonValueKind.Object && data.TryGetProperty(name, out var value) ? value : default;
    private static string Text(JsonElement data, string name) => Get(data, name) is var value && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    private static bool Bool(JsonElement data, string name) => Get(data, name).ValueKind == JsonValueKind.True;
    private static IEnumerable<JsonElement> Rows(JsonElement data, string name) => Get(data, name) is var value && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray() : [];
    private static bool Number(JsonElement data, string name, out double value)
    {
        var item = Get(data, name);
        value = 0;
        return (item.ValueKind == JsonValueKind.Number ? item.TryGetDouble(out value) : item.ValueKind == JsonValueKind.String && double.TryParse(item.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value)) && double.IsFinite(value);
    }
    private static bool Count(JsonElement data, string name, out double count) => Number(data, name, out count) && count >= 0 && count <= SafeInteger && Math.Floor(count) == count;
    private static bool Fresh(JsonElement data, string name, long now, long age)
    {
        if (!Number(data, name, out var at))
        {
            if (!DateTimeOffset.TryParse(Text(data, name), CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)) return false;
            at = date.ToUnixTimeMilliseconds();
        }
        return at > 0 && at <= now + 2000 && now - at <= age;
    }
    private static string Nonempty(string value, string fallback) => string.IsNullOrWhiteSpace(value) ? fallback : value;
    private static string Format(double value) => value.ToString("N0", Culture);
}
