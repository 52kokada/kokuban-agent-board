using Kokuban.Core;

public class DesktopActivityTests
{
    [Fact]
    public void UnconfiguredDirectoryDoesNotFallBackToAnotherCheckout()
    {
        Assert.Null(DesktopActivity.Read("Copper", 0, null));
        Assert.Null(DesktopActivity.Read("Copper", 0, "relative/activity"));
    }

    [Fact]
    public void InvalidConfiguredDirectoryIsUnavailable()
        => Assert.Null(DesktopActivity.Read("Copper", 0, Path.GetPathRoot(AppContext.BaseDirectory) + "fixture\0invalid"));
    private const long Now = 100000;
    [Fact]
    public void ActivityBelongsToExactAgent()
    {
        var json = """{"agent":"Alder","state":"running","action":"set-value","updatedAt":99000,"session":"run-1"}""";
        Assert.Equal("入力中", DesktopActivity.Parse(json, "Alder", Now)!.Label);
        Assert.Null(DesktopActivity.Parse(json, "Claude", Now));
    }
    [Fact]
    public void OldRunningActivityIsUnknownNotRunning()
    {
        var json = """{"agent":"Alder","state":"running","action":"click","updatedAt":1,"session":"run-1"}""";
        Assert.Equal("操作状況を確認できません", DesktopActivity.Parse(json, "Alder", Now)!.Label);
    }
    [Fact]
    public void DeliveredClickDoesNotBecomeVerified()
    {
        var json = """{"agent":"Alder","state":"delivered_unverified","action":"click","updatedAt":99000,"session":"run-1"}""";
        Assert.Equal("操作済み・結果は未確認", DesktopActivity.Parse(json, "Alder", Now)!.Label);
    }
    [Fact]
    public void EndedAndInvalidActivityAreHidden()
    {
        Assert.Null(DesktopActivity.Parse("{}", "Alder", Now));
        Assert.Null(DesktopActivity.Parse("bad json", "Alder", Now));
        Assert.Null(DesktopActivity.Parse("""{"agent":"Alder","state":"ended","action":"click","updatedAt":99000,"session":"run-1"}""", "Alder", Now));
    }
    [Fact]
    public void FutureAndUnknownStatesAreRejected()
    {
        Assert.Null(DesktopActivity.Parse("""{"agent":"Alder","state":"running","action":"click","updatedAt":999999,"session":"run-1"}""", "Alder", Now));
        Assert.Null(DesktopActivity.Parse("""{"agent":"Alder","state":"success","action":"click","updatedAt":99000,"session":"run-1"}""", "Alder", Now));
    }
}
