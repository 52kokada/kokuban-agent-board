using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Kokuban.App;

/// <summary>
/// One Kokuban per person and board: a second start (the Start menu, a card's link, the hotkey's
/// shortcut, the login entry) hands its arguments to the running one and ends.
/// </summary>
public static class Program
{
    /// <summary>A test board on another port gets its own app, as the board's own names do.</summary>
    public static string InstanceKey => Kokuban.Core.BoardClient.Demo ? $"Kokuban-{Kokuban.Core.BoardClient.Port}" : "Kokuban";

    /// <summary>
    /// --offscreen: windows open beyond every monitor, shown without taking the foreground, for checks
    /// that capture them (PrintWindow) without anything appearing on the person's screen.
    /// </summary>
    public static bool Offscreen { get; private set; }

    /// <summary>Arguments handed over by a second start, for the running app.</summary>
    public static event Action<string[]>? Handed;

    [STAThread]
    private static int Main(string[] args)
    {
        // Velopack's install, update and uninstall steps run here and end the process when they are the reason it started.
        Updater.Hooks();
        // --port n: a test board (the same as KOKUBAN_PORT); --pill-test: a pill a test driver can move and act on.
        var at = Array.IndexOf(args, "--port");
        if (at >= 0 && at + 1 < args.Length && int.TryParse(args[at + 1], out var port)) Kokuban.Core.BoardClient.Port = port;
        if (args.Contains("--pill-test")) PillWindow.Test = true;
        Offscreen = args.Contains("--offscreen");
        WinRT.ComWrappersSupport.InitializeComWrappers();
        var self = AppInstance.FindOrRegisterForKey(InstanceKey);
        if (!self.IsCurrent)
        {
            Redirect(self);
            return 0;
        }
        self.Activated += (_, e) =>
        {
            var line = e.Data is Windows.ApplicationModel.Activation.ILaunchActivatedEventArgs launch ? launch.Arguments : "";
            Handed?.Invoke(Split(line));
        };
        Application.Start(p =>
        {
            SynchronizationContext.SetSynchronizationContext(new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            _ = new App(args);
        });
        return 0;
    }

    /// <summary>Hand this start over to the running app, without blocking this thread's COM apartment while it is done.</summary>
    private static void Redirect(AppInstance running)
    {
        // Let the running app bring its window to the front: it was asked for by the person.
        AllowSetForegroundWindow(running.ProcessId);
        var done = CreateEvent(0, true, false, null);
        var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
        Task.Run(() =>
        {
            running.RedirectActivationToAsync(activation).AsTask().Wait();
            SetEvent(done);
        });
        CoWaitForMultipleObjects(0, 0xFFFFFFFF, 1, [done], out _);
    }

    /// <summary>A command line as Windows splits it, without the program's own name.</summary>
    public static string[] Split(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return [];
        var argv = CommandLineToArgvW(line, out var n);
        if (argv == 0) return [];
        try
        {
            var all = new string[n];
            for (var i = 0; i < n; i++) all[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)) ?? "";
            // Unpackaged, Windows passes the whole command line, the program first.
            return all.Length > 0 && all[0].EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? all[1..] : all;
        }
        finally
        {
            LocalFree(argv);
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern nint CreateEvent(nint attributes, bool manual, bool initial, string? name);

    [DllImport("kernel32.dll")]
    private static extern bool SetEvent(nint handle);

    [DllImport("ole32.dll")]
    private static extern uint CoWaitForMultipleObjects(uint flags, uint timeout, uint count, nint[] handles, out uint index);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(uint pid);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern nint CommandLineToArgvW(string line, out int count);

    [DllImport("kernel32.dll")]
    private static extern nint LocalFree(nint mem);
}
