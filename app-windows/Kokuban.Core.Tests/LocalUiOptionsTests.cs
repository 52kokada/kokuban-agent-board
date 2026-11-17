using Kokuban.Core;

public class LocalUiOptionsTests
{
    [Fact]
    public void DefaultsDoNotAssumeAnotherPcsPathsOrRestrictItsMonitor()
    {
        var options = new LocalUiOptions();
        Assert.Null(options.UsageToolsDirectory);
        Assert.Null(options.DesktopActivityDirectory);
        Assert.Null(options.PlaybackUri());
        Assert.False(options.RestrictPillToMonitor);
        Assert.False(options.SessionLauncher);
        Assert.False(options.RevealPillOnHover);
    }

    [Theory]
    [InlineData("https://example.com/status")]
    [InlineData("http://localhost:4017/status")]
    [InlineData("http://user:pass@127.0.0.1:4017/status")]
    [InlineData("file:///C:/secret")]
    public void PlaybackCannotSendRequestsOutsideAnExplicitLoopbackIp(string url)
        => Assert.Null(new LocalUiOptions { PlaybackStatusUrl = url }.PlaybackUri());

    [Fact]
    public void LocalPlaybackIsExplicit()
        => Assert.Equal("127.0.0.1", new LocalUiOptions { PlaybackStatusUrl = "http://127.0.0.1:4017/v1/playback-status" }.PlaybackUri()!.Host);
}
