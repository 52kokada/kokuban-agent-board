using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;

namespace Kokuban.App.Ui;

/// <summary>Brushes from Styles.xaml for an element's own theme, for code that paints by hand.</summary>
public static class Theme
{
    public static Brush Brush(FrameworkElement on, string key)
    {
        var theme = on.ActualTheme == ElementTheme.Dark ? "Dark" : "Light";
        foreach (var merged in Application.Current.Resources.MergedDictionaries)
        {
            if (merged.ThemeDictionaries.TryGetValue(theme, out var t) && t is ResourceDictionary d && d.TryGetValue(key, out var b) && b is Brush brush)
                return brush;
        }
        throw new KeyNotFoundException($"no brush {key} in Styles.xaml");
    }

    public static readonly SolidColorBrush White = new(Microsoft.UI.Colors.White);

    /// <summary>Segoe UI Variable's display cut, for 16 px and up (smaller text uses the default text cut).</summary>
    public static readonly FontFamily Display = new("Segoe UI Variable Display");
    public static readonly SolidColorBrush White80 = new(Windows.UI.Color.FromArgb(204, 255, 255, 255));
    public static readonly SolidColorBrush White60 = new(Windows.UI.Color.FromArgb(153, 255, 255, 255));

    /// <summary>The sidebar's line icons, the same strokes as the web page's.</summary>
    public static readonly Dictionary<string, string> Icons = new()
    {
        ["you"] = "M2 9.5 4 3h8l2 6.5V13H2z M2 9.5h3.5l1 1.5h3l1-1.5H14",
        ["theirs"] = "M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8Z M8 5v3l2 1.5",
        ["live"] = "M2 8h3l2-4 2 8 2-4h3",
        ["hist"] = "M3 3v10h10 M6 10V7M9 10V5M12 10V8",
    };

    public static FrameworkElement Icon(string name)
    {
        var path = new Microsoft.UI.Xaml.Shapes.Path
        {
            Data = (Geometry)XamlBindingHelper.ConvertValue(typeof(Geometry), Icons[name]),
            StrokeThickness = 1.4,
            StrokeLineJoin = PenLineJoin.Round,
            StrokeStartLineCap = PenLineCap.Round,
            StrokeEndLineCap = PenLineCap.Round,
            Width = 16,
            Height = 16,
            Stretch = Stretch.None,
        };
        KindPaint.SetStroke(path, "accent");
        return path;
    }
}
