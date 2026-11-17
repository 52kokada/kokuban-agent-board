using System.Text.Json;
using System.Text.RegularExpressions;

namespace Kokuban.Core;

/// <summary>Local desktop activity only; no input text, screenshots, or execution.</summary>
public sealed record DesktopActivity(string Label, string Action, bool Running)
{
    public static DesktopActivity? Read(string agent, long now, string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathFullyQualified(directory)) return null;
        if (!Regex.IsMatch(agent, "^[A-Za-z0-9_-]{1,64}$")) return null;
        try
        {
            var file = Path.Combine(directory, agent + ".json");
            if (new FileInfo(file).Length > 16384) return null;
            return Parse(File.ReadAllText(file), agent, now);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return null; }
    }

    public static DesktopActivity? Parse(string json, string agent, long now)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            string Text(string key) => r.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() ?? "" : "";
            if (Text("agent") != agent || Text("session").Length == 0 ||
                !r.TryGetProperty("updatedAt", out var at) || !at.TryGetInt64(out var timestamp)) return null;
            var age = now - timestamp;
            if (age < -5000 || age > 300000) return null;
            var state = Text("state");
            var action = Text("action");
            var label = state switch
            {
                "running" when age > 30000 => "操作状況を確認できません",
                "running" => action switch { "set-value" or "clear" => "入力中", "snapshot" or "get" or "find" => "画面を確認中", _ => "PCを操作中" },
                "delivered_verified" => "操作結果を確認済み",
                "delivered_unverified" => "操作済み・結果は未確認",
                "observed" => "画面を確認しました",
                "ready" => "PC操作に接続済み",
                "error" => "操作を中断しました",
                "unknown" => "操作結果を確認できません",
                _ => null
            };
            return label is null ? null : new(label, action, state == "running" && age <= 30000);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException) { return null; }
    }
}
