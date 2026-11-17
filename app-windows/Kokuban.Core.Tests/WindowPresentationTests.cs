using Kokuban.Core;

public class WindowPresentationTests
{
    [Fact]
    public void AgentOpenNeverRequestsKeyboardFocus()
        => Assert.False(WindowPresentation.ShouldActivate(["--no-activate"], null));
    [Fact]
    public void ExistingPassiveEnvironmentIsPreserved()
        => Assert.False(WindowPresentation.ShouldActivate([], "1"));
    [Fact]
    public void ExplicitHumanOpenCanReceiveFocus()
        => Assert.True(WindowPresentation.ShouldActivate([], null));
    [Fact]
    public void PassiveOpenAlsoCoversSelectedViews()
        => Assert.False(WindowPresentation.ShouldActivate(["--sessions", "--no-activate"], null));
    [Theory]
    [InlineData("--settings")]
    [InlineData("--pill")]
    [InlineData("--feed")]
    public void PassiveFlagCannotReachActivatingAlternateViews(string view)
        => Assert.True(WindowPresentation.RejectPassiveView([view, "--no-activate"], null));
    [Fact]
    public void HumanSettingsAreStillAvailable()
        => Assert.False(WindowPresentation.RejectPassiveView(["--settings"], null));
}
