namespace Kokuban.Core;

/// <summary>
/// The words of the pill and the window, the same as the approved design (docs/feed-mockup-v2.html). The
/// language is the board's (`lang` in feed.json), not Windows', so a PC set to Japanese on the board
/// reads Japanese whatever Windows is set to.
/// </summary>
public sealed class Strings
{
    public required string ForYou, WaitingOn, Running, History, Projects, Later, AllClear, Nothing, Decide, Go,
        Blocked, Done, Reply, Send, Open, Close, Happened, Files, Doing, Next, Holds, Sessions, Nobody, NoRunning,
        NoHistory, ForYouN, Offline, Now, Seen, Cancel, Prev, NextItem, NoBoard, Retry,
        OpenApp, Pause, Resume, Settings, Quit, StartAtLogin, Hotkey, Change, PressKeys, HotkeyTaken, FileElsewhere, FileGone, Disagreement;

    public required bool Japanese;

    public string Kind(string kind) => kind switch
    {
        Kinds.Decide => Decide,
        Kinds.Go => Go,
        Kinds.Blocked => Blocked,
        Kinds.Done => Done,
        _ => "",
    };

    public string WaitingOnPerson(string person) => Japanese ? $"{person}待ち" : $"{WaitingOn} {person}";

    public static Strings For(string? lang) => lang == "ja" ? Ja : En;

    public static readonly Strings En = new()
    {
        Japanese = false,
        ForYou = "For you", WaitingOn = "Waiting on", Running = "Running", History = "History", Projects = "Projects",
        Later = "Later", AllClear = "All clear", Nothing = "Nothing waits on you.", Decide = "Decide", Go = "Ready to start",
        Blocked = "Blocked", Done = "Finished", Reply = "Reply…", Send = "Send", Open = "Open in window", Close = "Close",
        Happened = "What happened", Files = "Files", Doing = "Doing", Next = "Next", Holds = "Holds", Sessions = "sessions",
        Nobody = "Nobody", NoRunning = "No hand-off is running.", NoHistory = "Nothing yet.", ForYouN = "for you",
        Offline = "not answering", Now = "now", Seen = "Seen", Cancel = "Cancel task", Prev = "Previous", NextItem = "Next",
        NoBoard = "The board on this PC is not answering.", Retry = "Trying again…",
        OpenApp = "Open Kokuban", Pause = "Pause the pill for 1 hour", Resume = "Resume the pill", Settings = "Settings", Quit = "Quit",
        StartAtLogin = "Start when I sign in", Hotkey = "Hotkey", Change = "Change", PressKeys = "Press the new keys",
        HotkeyTaken = "Another program holds these keys.", FileElsewhere = "This file is on {0}: open it there.", FileGone = "This file is no longer on this PC.", Disagreement = "Disagreement",
    };

    public static readonly Strings Ja = new()
    {
        Japanese = true,
        ForYou = "あなた宛て", WaitingOn = "待ち:", Running = "進行中", History = "履歴", Projects = "プロジェクト",
        Later = "あとで", AllClear = "すべて完了", Nothing = "あなた待ちのものはありません。", Decide = "判断", Go = "開始待ち",
        Blocked = "停止中", Done = "完了", Reply = "返信…", Send = "送信", Open = "ウィンドウで開く", Close = "閉じる",
        Happened = "経緯", Files = "ファイル", Doing = "作業中", Next = "次", Holds = "確保中", Sessions = "セッション",
        Nobody = "なし", NoRunning = "進行中の引き継ぎはありません。", NoHistory = "まだありません。", ForYouN = "件 あなた宛て",
        Offline = "応答なし", Now = "今", Seen = "確認済み", Cancel = "タスクを取消", Prev = "前へ", NextItem = "次へ",
        NoBoard = "このPCのボードが応答していません。", Retry = "再接続中…",
        OpenApp = "Kokuban を開く", Pause = "ピルを1時間止める", Resume = "ピルを再開", Settings = "設定", Quit = "終了",
        StartAtLogin = "サインイン時に起動", Hotkey = "ショートカットキー", Change = "変更", PressKeys = "新しいキーを押してください",
        HotkeyTaken = "このキーは別のプログラムが使っています。", FileElsewhere = "このファイルは {0} にあります。そちらで開いてください。", FileGone = "このファイルはもうこのPCにありません。", Disagreement = "意見が分かれています",
    };

    // JavaScript's Math.round, which the web page uses.
    private static double R(double x) => Math.Round(x, MidpointRounding.AwayFromZero);

    /// <summary>How long ago, as the web page says it: now, 5m, 3h, 2d.</summary>
    public string Ago(long ts, long now)
    {
        var s = Math.Max(0, (now - ts) / 1000.0);
        return s < 60 ? Now : s < 3600 ? $"{R(s / 60)}m" : s < 86400 ? $"{R(s / 3600)}h" : $"{R(s / 86400)}d";
    }
}
