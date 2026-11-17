namespace Kokuban.Core;

public sealed record PillMonitor(string Id, bool Primary, int Left, int Top, int Right, int Bottom);

public static class PillPlacement
{
    public static PillMonitor? Select(IReadOnlyList<PillMonitor> monitors, string? allowedId)
    {
        if (string.IsNullOrWhiteSpace(allowedId)) return null;
        var mains = monitors.Where(m => m.Primary).ToArray();
        if (mains.Length != 1) return null;
        var main = mains[0];
        // Only a screen wholly above the main screen. Side screens and the main screen
        // are never fallbacks, even after Windows renumbers or rearranges displays.
        var safe = monitors.Where(m => string.Equals(m.Id, allowedId, StringComparison.OrdinalIgnoreCase)
            && !m.Primary && m.Top < main.Top && m.Bottom <= main.Top
            && m.Left < main.Right && m.Right > main.Left).ToArray();
        return safe.Length == 1 ? safe[0] : null;
    }
}
