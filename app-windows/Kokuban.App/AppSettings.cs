using System.Text.Json;
using Microsoft.Win32;

namespace Kokuban.App;

/// <summary>
/// The app's own few settings, beside the board's data (%LOCALAPPDATA%\kokuban\app-windows.json):
/// the hotkey, starting at sign-in, and a pause of the pill.
/// </summary>
public sealed class AppSettings
{
    private static readonly string File = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "kokuban", $"app-windows{Suffix}.json");
    private static string Suffix => Program.InstanceKey == "Kokuban" ? "" : Program.InstanceKey[7..];

    /// <summary>MOD_ALT 1, MOD_CONTROL 2, MOD_SHIFT 4, MOD_WIN 8.</summary>
    public uint HotkeyModifiers { get; set; } = 1 | 2;

    /// <summary>A virtual key; K by default (decision 11: not Ctrl+Space, which switches the input method).</summary>
    public uint HotkeyKey { get; set; } = 'K';

    public bool StartAtLogin { get; set; } = true;

    public Kokuban.Core.LocalUiOptions LocalUi { get; set; } = new();

    public DateTimeOffset? PausedUntil { get; set; }

    public bool Paused => PausedUntil > DateTimeOffset.Now;

    public static AppSettings Load()
    {
        try
        {
            return JsonSerializer.Deserialize<AppSettings>(System.IO.File.ReadAllText(File)) ?? new AppSettings();
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return new AppSettings();
        }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(File)!);
            System.IO.File.WriteAllText(File, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (IOException e)
        {
            Log.Write($"settings not saved: {e.Message}");
        }
    }

    /// <summary>"Ctrl+Alt+K", as Windows writes a shortcut.</summary>
    public string HotkeyName
    {
        get
        {
            var parts = new List<string>();
            if ((HotkeyModifiers & 2) != 0) parts.Add("Ctrl");
            if ((HotkeyModifiers & 1) != 0) parts.Add("Alt");
            if ((HotkeyModifiers & 4) != 0) parts.Add("Shift");
            if ((HotkeyModifiers & 8) != 0) parts.Add("Win");
            parts.Add(((Windows.System.VirtualKey)HotkeyKey).ToString());
            return string.Join("+", parts);
        }
    }

    // -- starting at sign-in --------------------------------------------------------------------------

    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    /// <summary>
    /// Only an installed copy (Velopack's %LOCALAPPDATA%\KokubanApp\current) starts at sign-in: a build run
    /// from a checkout must never put itself there.
    /// </summary>
    public static bool Installed =>
        Environment.ProcessPath?.Contains(@"\KokubanApp\current\", StringComparison.OrdinalIgnoreCase) == true;

    /// <summary>Make the sign-in entry match the setting (HKCU, no elevation).</summary>
    public void ApplyStartAtLogin()
    {
        if (!Installed || Program.InstanceKey != "Kokuban") return;
        using var run = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        if (run is null) return;
        if (StartAtLogin) run.SetValue("Kokuban", $"\"{Environment.ProcessPath}\" --background");
        else run.DeleteValue("Kokuban", throwOnMissingValue: false);
    }
}
