namespace Kokuban.App;

/// <summary>A small log beside the board's data: %LOCALAPPDATA%\kokuban\app-windows.log, cut when it passes 1 MB.</summary>
public static class Log
{
    private static readonly string File = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "kokuban", "app-windows.log");
    private static readonly Lock Gate = new();

    /// <summary>KOKUBAN_TRACE=1: log every line of the window that is drawn again, to check that nothing redraws for no reason.</summary>
    public static readonly bool Tracing = Environment.GetEnvironmentVariable("KOKUBAN_TRACE") == "1";

    public static void Trace(string text)
    {
        if (Tracing) Write($"draw {text}");
    }

    public static void Write(string text)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(File)!);
                if (System.IO.File.Exists(File) && new FileInfo(File).Length > 1_000_000) System.IO.File.Delete(File);
                System.IO.File.AppendAllText(File, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff} [{Environment.ProcessId}] {text}{Environment.NewLine}");
            }
        }
        catch (IOException)
        {
        }
    }
}
