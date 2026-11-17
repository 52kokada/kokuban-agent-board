using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// The provider starts suspended, is assigned to a kill-on-close Job, then runs.
// If Node or this host dies, closing the last Job handle terminates the owned tree.
internal static class Program
{
    public static int Main(string[] args)
    {
        if (args.Length < 2 || !uint.TryParse(args[0], out var parentId) || !Path.IsPathFullyQualified(args[1])) return 64;
        try
        {
            using var parent = OpenProcess(0x00100000, false, parentId);
            if (parent.IsInvalid) throw new Win32Exception();
            using var job = CreateJobObject(IntPtr.Zero, null);
            if (job.IsInvalid) throw new Win32Exception();
            var limit = new JobLimits { BasicLimitInformation = new BasicLimits { LimitFlags = 0x2000 } };
            if (!SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf<JobLimits>())) throw new Win32Exception();
            var startup = new StartupInfo { cb = Marshal.SizeOf<StartupInfo>(), dwFlags = 0x100,
                hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
            var command = new StringBuilder(string.Join(" ", args.Skip(1).Select(Quote)));
            if (!CreateProcess(args[1], command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out var process)) throw new Win32Exception();
            using var processHandle = new SafeFileHandle(process.hProcess, true);
            using var threadHandle = new SafeFileHandle(process.hThread, true);
            if (!AssignProcessToJobObject(job, processHandle))
            {
                TerminateProcess(processHandle, 70);
                throw new Win32Exception();
            }
            if (ResumeThread(threadHandle) == uint.MaxValue) { TerminateProcess(processHandle, 70); throw new Win32Exception(); }
            if (WaitForMultipleObjects(2, [process.hProcess, parent.DangerousGetHandle()], false, uint.MaxValue) != 0) return 70;
            if (!GetExitCodeProcess(processHandle, out var exitCode)) throw new Win32Exception();
            return unchecked((int)exitCode);
        }
        catch (Exception e) when (e is Win32Exception or IOException)
        {
            Console.Error.WriteLine("Agent process containment failed.");
            return 70;
        }
    }

    // CommandLineToArgvW-compatible quoting; no shell is involved.
    private static string Quote(string value)
    {
        var result = new StringBuilder("\""); var slashes = 0;
        foreach (var c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
            result.Append('\\', slashes).Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JobLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    { public int cb; public string? lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref JobLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string? directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int value);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(SafeFileHandle thread);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(SafeFileHandle process, out uint code);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(SafeFileHandle process, uint code);
}
