namespace Kokuban.Core.Tests;

public class PillVisibilityTests
{
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    public void Notifications_are_hidden_until_nearby_but_open_cards_stay_visible(
        bool cardOpen, bool near, bool expected)
    {
        Assert.Equal(expected, PillVisibility.ShouldReveal(cardOpen, near));
    }
}
