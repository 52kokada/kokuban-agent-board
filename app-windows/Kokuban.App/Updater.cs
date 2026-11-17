using Kokuban.Core;
using Velopack;
using Velopack.Sources;

namespace Kokuban.App;

/// <summary>
/// The app updates itself from this PC's board (src/app-update.ts), which got the new version from a
/// paired PC: no store, no download site. A new version is downloaded in the background and applied
/// once none of the app's windows is open, then the app starts again in the tray.
/// </summary>
public static class Updater
{
    private static UpdateManager? _manager;
    private static UpdateInfo? _ready;

    /// <summary>Velopack's install, update and uninstall steps; first thing at start, before anything else runs.</summary>
    public static void Hooks() => VelopackApp.Build()
        .OnBeforeUninstallFastCallback(_ => new AppSettings { StartAtLogin = false }.ApplyStartAtLogin())
        .Run();

    private static UpdateManager Manager => _manager ??= new UpdateManager(new SimpleWebSource(new Uri(BoardClient.DefaultBase, "app/releases/")));

    /// <summary>The installed version, or null for a copy that was not installed (a build run from a checkout).</summary>
    public static string? Version => AppSettings.Installed && Manager.IsInstalled ? Manager.CurrentVersion?.ToString() : null;

    /// <summary>Look for a newer version on the board and download it. True when one is ready to apply.</summary>
    public static async Task<bool> CheckAsync()
    {
        if (_ready is not null) return true;
        if (Version is null) return false;
        try
        {
            var info = await Manager.CheckForUpdatesAsync();
            if (info is null) return false;
            await Manager.DownloadUpdatesAsync(info);
            _ready = info;
            Log.Write($"update {info.TargetFullRelease.Version} downloaded");
            return true;
        }
        catch (Exception e)
        {
            // A board without a feed yet, or one that is restarting: try again next time.
            Log.Write($"update check: {e.Message}");
            return false;
        }
    }

    /// <summary>Hand over to Velopack, which applies the update once this process has ended and starts it again in the tray.</summary>
    public static bool Apply()
    {
        if (_ready is null) return false;
        Manager.WaitExitThenApplyUpdates(_ready.TargetFullRelease, silent: true, restart: true, ["--background"]);
        return true;
    }
}
