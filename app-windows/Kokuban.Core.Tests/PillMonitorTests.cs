namespace Kokuban.Core.Tests;

public class PillMonitorTests
{
    private static readonly PillMonitor Main = new("main", true, 0, 0, 3072, 1728);
    private static readonly PillMonitor Upper = new("upper", false, 540, -1440, 3100, 0);
    private static readonly PillMonitor Left = new("left", false, -1440, -405, 0, 2155);
    private static readonly PillMonitor Right = new("right", false, 3840, -405, 5280, 2155);

    [Fact]
    public void Connected_upper_monitor_is_selected() =>
        Assert.Equal(Upper, PillPlacement.Select([Main, Left, Right, Upper], "upper"));

    [Fact]
    public void Unplugged_upper_monitor_suppresses_instead_of_falling_back() =>
        Assert.Null(PillPlacement.Select([Main, Left, Right], "upper"));

    [Fact]
    public void Single_main_monitor_never_receives_notifications() =>
        Assert.Null(PillPlacement.Select([Main], "main"));

    [Fact]
    public void Missing_primary_or_ambiguous_upper_monitor_suppresses()
    {
        Assert.Null(PillPlacement.Select([Upper, Left], "upper"));
        Assert.Null(PillPlacement.Select([Main, Upper, Upper], "upper"));
    }

    [Fact]
    public void Monitor_promoted_to_primary_is_never_selected() =>
        Assert.Null(PillPlacement.Select([Upper with { Primary = true }, Main with { Primary = false }], "upper"));

    [Fact]
    public void Physical_identity_is_required_even_if_replacement_has_same_coordinates()
    {
        Assert.Null(PillPlacement.Select([Main, Upper with { Id = "central-renumbered" }], "upper"));
        Assert.Null(PillPlacement.Select([Main, Upper], null));
    }
}
