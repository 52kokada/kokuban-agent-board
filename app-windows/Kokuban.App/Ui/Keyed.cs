using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Kokuban.App.Ui;

public static class Keyed
{
    /// <summary>
    /// Make <paramref name="panel"/> show <paramref name="wanted"/> with as few changes as possible:
    /// a line whose key stays keeps its control (and its hover, focus and animations) and is given
    /// the new entry in place; only lines that came or went are inserted or removed. Answers the
    /// lines that came.
    /// </summary>
    public static List<TLine> Sync<TEntry, TLine>(Panel panel, IReadOnlyList<TEntry> wanted, Func<TEntry, string> key, Func<TLine> make, Action<TLine, TEntry> set)
        where TLine : FrameworkElement
    {
        var made = new List<TLine>();
        var keys = wanted.Select(key).ToList();
        var keep = keys.ToHashSet();
        for (var i = panel.Children.Count - 1; i >= 0; i--)
            if (panel.Children[i] is not FrameworkElement { Tag: string k } || !keep.Contains(k)) panel.Children.RemoveAt(i);
        for (var i = 0; i < wanted.Count; i++)
        {
            var at = -1;
            for (var j = i; j < panel.Children.Count; j++)
            {
                if ((string)((FrameworkElement)panel.Children[j]).Tag != keys[i]) continue;
                at = j;
                break;
            }
            TLine line;
            if (at < 0)
            {
                line = make();
                line.Tag = keys[i];
                panel.Children.Insert(i, line);
                made.Add(line);
            }
            else
            {
                line = (TLine)panel.Children[at];
                if (at != i) panel.Children.Move((uint)at, (uint)i);
            }
            set(line, wanted[i]);
        }
        return made;
    }
}
