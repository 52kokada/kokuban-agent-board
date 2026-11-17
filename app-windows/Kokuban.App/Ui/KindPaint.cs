using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace Kokuban.App.Ui;

/// <summary>
/// The colours of the kinds, as the web page has them: decide amber, go blue, blocked red, done
/// green, idle a faint grey. Set <c>KindPaint.Kind</c> on a shape (its fill), a border or a button
/// (its background); it follows the light or dark theme.
/// </summary>
public static class KindPaint
{
    private static readonly Dictionary<string, (Color Light, Color Dark)> Colors = new()
    {
        ["decide"] = (Hex(0xff9500), Hex(0xff9f0a)),
        ["go"] = (Hex(0x007aff), Hex(0x0a84ff)),
        ["blocked"] = (Hex(0xff3b30), Hex(0xff453a)),
        ["done"] = (Hex(0x34c759), Hex(0x30d158)),
        ["accent"] = (Hex(0x007aff), Hex(0x0a84ff)),
        ["idle"] = (Color.FromArgb(92, 60, 60, 67), Color.FromArgb(77, 235, 235, 245)),
    };

    private static Color Hex(uint rgb) => Color.FromArgb(255, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);

    public static Color ColorOf(string kind, ElementTheme theme)
    {
        var c = Colors.TryGetValue(kind, out var pair) ? pair : Colors["idle"];
        return theme == ElementTheme.Dark ? c.Dark : c.Light;
    }

    private static readonly Dictionary<(string, ElementTheme), SolidColorBrush> Brushes = [];

    public static SolidColorBrush BrushOf(string kind, ElementTheme theme)
    {
        if (!Brushes.TryGetValue((kind, theme), out var b)) Brushes[(kind, theme)] = b = new SolidColorBrush(ColorOf(kind, theme));
        return b;
    }

    public static readonly DependencyProperty KindProperty = DependencyProperty.RegisterAttached(
        "Kind", typeof(string), typeof(KindPaint), new PropertyMetadata(null, OnKind));

    public static string GetKind(DependencyObject o) => (string)o.GetValue(KindProperty);

    public static void SetKind(DependencyObject o, string value) => o.SetValue(KindProperty, value);

    /// <summary>The same colours as a shape's stroke (the sidebar's line icons).</summary>
    public static readonly DependencyProperty StrokeProperty = DependencyProperty.RegisterAttached(
        "Stroke", typeof(string), typeof(KindPaint), new PropertyMetadata(null, OnKind));

    public static string GetStroke(DependencyObject o) => (string)o.GetValue(StrokeProperty);

    public static void SetStroke(DependencyObject o, string value) => o.SetValue(StrokeProperty, value);

    private static readonly DependencyProperty HookedProperty = DependencyProperty.RegisterAttached(
        "Hooked", typeof(bool), typeof(KindPaint), new PropertyMetadata(false));

    private static void OnKind(DependencyObject o, DependencyPropertyChangedEventArgs e)
    {
        if (o is not FrameworkElement fe) return;
        if (!(bool)fe.GetValue(HookedProperty))
        {
            fe.SetValue(HookedProperty, true);
            fe.ActualThemeChanged += (s, _) => Paint((FrameworkElement)s);
        }
        Paint(fe);
    }

    private static void Paint(FrameworkElement fe)
    {
        if (GetStroke(fe) is { } stroke && fe is Shape line) line.Stroke = BrushOf(stroke, fe.ActualTheme);
        var kind = GetKind(fe);
        if (kind is null) return;
        var brush = BrushOf(kind, fe.ActualTheme);
        switch (fe)
        {
            case Shape s: s.Fill = brush; break;
            case Border b: b.Background = brush; break;
            case Control c: c.Background = brush; break;
            case Panel p: p.Background = brush; break;
        }
    }

    /// <summary>A person's colour, from their name, as the web page's avatars have it (hsl(h 62% 52%)).</summary>
    public static Color PersonColor(string name)
    {
        var h = 0;
        foreach (var ch in name) h = (h * 31 + ch) % 360;
        return Hsl(h, 0.62, 0.52);
    }

    private static Color Hsl(double h, double s, double l)
    {
        var c = (1 - Math.Abs(2 * l - 1)) * s;
        var x = c * (1 - Math.Abs(h / 60 % 2 - 1));
        var m = l - c / 2;
        var (r, g, b) = h switch
        {
            < 60 => (c, x, 0d),
            < 120 => (x, c, 0d),
            < 180 => (0d, c, x),
            < 240 => (0d, x, c),
            < 300 => (x, 0d, c),
            _ => (c, 0d, x),
        };
        return Color.FromArgb(255, (byte)Math.Round((r + m) * 255), (byte)Math.Round((g + m) * 255), (byte)Math.Round((b + m) * 255));
    }

    public static SolidColorBrush White { get; } = new(Microsoft.UI.Colors.White);
}
