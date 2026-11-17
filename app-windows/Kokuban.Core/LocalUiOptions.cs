using System.Net;

namespace Kokuban.Core;

/// <summary>Optional machine-local integrations. These values are never distributed with code.</summary>
public sealed class LocalUiOptions
{
    public bool SessionLauncher { get; set; }
    public string? UsageToolsDirectory { get; set; }
    public string NodeExecutable { get; set; } = "node";
    public string? PlaybackStatusUrl { get; set; }
    public string? DesktopActivityDirectory { get; set; }
    public bool RestrictPillToMonitor { get; set; }
    public bool RevealPillOnHover { get; set; }
    public string? PillMonitorDeviceId { get; set; }

    public Uri? PlaybackUri()
        => Uri.TryCreate(PlaybackStatusUrl, UriKind.Absolute, out var uri)
            && uri.Scheme == "http" && uri.UserInfo.Length == 0
            && IPAddress.TryParse(uri.Host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address)
            ? uri : null;
}
