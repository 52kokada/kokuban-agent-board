using System.Text.Json;
using Kokuban.Core;

public class UsageDashboardTests
{
    private static readonly long Now = DateTimeOffset.Now.ToUnixTimeMilliseconds();
    private static readonly string Day = DateTimeOffset.FromUnixTimeMilliseconds(Now).ToLocalTime().ToString("yyyy-MM-dd");
    private static string Json(object value) => JsonSerializer.Serialize(value);
    private static string Usage(long at, string? day = null, object? count = null) => Json(new { day = day ?? Day, observedAt = at, totalTokens = count ?? 1000, byHost = new { codex = 1000, claude = 0, kimi = 0 }, agents = new[] { new { id = "a", host = "codex", name = "Same", tokens = 1000 } } });
    private static object Session(string id, string host = "codex", string state = "working", bool verified = true, string work = "waiting") => new { id, host, name = "Same", state, verified, present = true, work, doing = "Task", next = "Next", project = "Repo" };
    private static string Live(long at, params object[] sessions) => Json(new { observedAt = at, sessions });

    [Fact]
    public void UnionUsesHostAndIdAndRetainsLiveWithoutUsage()
    {
        var snapshot = UsageDashboard.Build(Usage(Now), Live(Now, Session("a"), Session("old-root"), Session("a", "claude")), null, Now);
        Assert.Equal(3, snapshot.Agents.Count);
        Assert.Equal(3, snapshot.ActiveCount);
        var root = Assert.Single(snapshot.Agents, a => a.Key == "codex:old-root");
        Assert.False(root.HasTodayUsage);
        Assert.True(root.LivePresent);
        Assert.Equal("稼働中", root.State);
        Assert.Equal("#FFA23A", root.NameColor);
        Assert.Equal("#C69CFF", snapshot.Agents.Single(a => a.Host == "claude").NameColor);
        Assert.Equal("1,000", snapshot.TokenText);
    }

    [Fact]
    public void ManualAndUnverifiedNeverActiveAndDonePreserved()
    {
        var snapshot = UsageDashboard.Build(null, Live(Now, Session("manual-a", work: "done"), Session("b", verified: false), Session("c", state: "idle")), null, Now);
        Assert.Equal(0, snapshot.ActiveCount);
        Assert.Equal("完了", snapshot.Agents.Single(a => a.Key == "codex:manual-a").State);
        Assert.All(snapshot.Agents, a => Assert.Equal("#E0E0E6", a.NameColor));
    }

    [Fact]
    public void StaleAndInvalidUsageCannotInventActivityOrTotals()
    {
        var snapshot = UsageDashboard.Build(Usage(Now - 90001), Live(Now - 30001, Session("a")), null, Now);
        Assert.Equal("—", snapshot.TokenText);
        Assert.Equal(0, snapshot.ActiveCount);
        Assert.False(Assert.Single(snapshot.Agents).LivePresent);
        Assert.Contains("最終", snapshot.Metadata);
        Assert.Equal("—", UsageDashboard.Build(Usage(Now, "2000-01-01"), null, null, Now).TokenText);
        Assert.Equal("—", UsageDashboard.Build(Usage(Now, count: 9007199254740992d), null, null, Now).TokenText);
    }

    private static string Playback(int limit = 0, long bonus = 1200000, long bank = 0, long? at = null) => Json(new { version = 1, day = Day, observedAt = at ?? Now, receivedAt = at ?? Now, remainingMs = 61000, bankRemainingMs = bank, bonusTodayMs = bonus, usedMs = 0, limitMinutes = limit, earnedTokens = 200000000, generation = true, generationActive = true, generationConnected = true, generationReason = "", extensionVersion = "1.18.4" });

    [Fact]
    public void PlaybackUsesActualBankAndUncappedVersion()
    {
        var snapshot = UsageDashboard.Build(null, null, Playback(), Now);
        Assert.Equal("1分01秒", snapshot.RemainingText);
        Assert.Equal("0.0 分", snapshot.BankText);
        Assert.Equal("発電中", snapshot.PlaybackStatus);
        Assert.DoesNotContain("旧版", snapshot.BonusText);
    }

    [Fact]
    public void LegacyCapAndStalePlaybackAreExplicit()
    {
        var snapshot = UsageDashboard.Build(null, null, Playback(45), Now);
        Assert.Contains("旧版", snapshot.BonusText);
        Assert.Contains("上限", snapshot.PlaybackStatus);
        Assert.DoesNotContain("発電中", snapshot.PlaybackStatus);
        Assert.Contains("最終取得値", UsageDashboard.Build(null, null, Playback(at: Now - 30001), Now).PlaybackStatus);
    }

    [Fact]
    public void CollectorWarningsUseShortJapaneseNote()
    {
        var usage = Json(new { day = Day, observedAt = Now, totalTokens = 0,
            byHost = new { codex = 0, claude = 0, kimi = 0 }, agents = Array.Empty<object>(),
            warnings = new[] { "codex: mixed-format logs use response usage only; internal details." } });
        var snapshot = UsageDashboard.Build(usage, null, null, Now);
        Assert.Contains("一部の記録は内訳を確認できません", snapshot.Metadata);
        Assert.DoesNotContain("mixed-format", snapshot.Metadata);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("{\"version\":1}")]
    public void MissingOrMalformedIsUnknown(string? data)
    {
        var snapshot = UsageDashboard.Build(data, data, data, Now);
        Assert.Equal("—", snapshot.TokenText);
        Assert.Equal("—", snapshot.BankText);
        Assert.Equal(0, snapshot.ActiveCount);
    }
}
