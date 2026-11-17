using Kokuban.App.Ui;
using Kokuban.Core;
using Microsoft.UI.Input;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace Kokuban.App;

/// <summary>The app's settings: starting at sign-in, and the hotkey (decision 11: changeable here).</summary>
public sealed class SettingsWindow : Window
{
    private readonly AppSettings _settings;
    private readonly Func<uint, uint, bool> _hold;
    private readonly Strings _t;
    private readonly TextBlock _keys = new() { FontSize = 14, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _note = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap };
    private readonly Button _change = new();
    private bool _listening;

    public SettingsWindow(AppSettings settings, Strings t, Func<uint, uint, bool> holdHotkey)
    {
        _settings = settings;
        _t = t;
        _hold = holdHotkey;
        Title = t.Settings;
        SystemBackdrop = new MicaBackdrop();
        ExtendsContentIntoTitleBar = true;
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));
        AppWindow.Resize(new Windows.Graphics.SizeInt32(460, 300));
        if (AppWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter frame)
        {
            frame.IsResizable = false;
            frame.IsMaximizable = false;
            frame.IsMinimizable = false;
        }

        var bar = new Grid { Height = 38, VerticalAlignment = VerticalAlignment.Top };
        var title = new TextBlock { Text = t.Settings, FontSize = 12, Margin = new Thickness(16, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        bar.Children.Add(title);

        var start = new ToggleSwitch { Header = t.StartAtLogin, IsOn = settings.StartAtLogin };
        start.Toggled += (_, _) =>
        {
            _settings.StartAtLogin = start.IsOn;
            _settings.ApplyStartAtLogin();
            _settings.Save();
        };

        _change.Content = t.Change;
        _change.Click += (_, _) => Listen();
        var hotkey = new StackPanel { Spacing = 6 };
        hotkey.Children.Add(new TextBlock { Text = t.Hotkey });
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
        row.Children.Add(_keys);
        row.Children.Add(_change);
        hotkey.Children.Add(row);
        hotkey.Children.Add(_note);

        var body = new StackPanel { Spacing = 22, Margin = new Thickness(24, 54, 24, 24) };
        body.Children.Add(start);
        body.Children.Add(hotkey);
        var root = new Grid();
        root.Children.Add(body);
        root.Children.Add(bar);
        root.KeyDown += OnKey;
        Content = root;
        SetTitleBar(bar);
        root.ActualThemeChanged += (_, _) => Paint(root);
        Paint(root);
        ShowKeys();
    }

    private void Paint(FrameworkElement on)
    {
        _note.Foreground = Theme.Brush(on, "Ink2");
    }

    private void ShowKeys()
    {
        _keys.Text = _listening ? _t.PressKeys : _settings.HotkeyName;
    }

    private void Listen()
    {
        _listening = true;
        _note.Text = "";
        ShowKeys();
        _change.Focus(FocusState.Programmatic);
    }

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        if (!_listening) return;
        var key = e.Key;
        if (key is VirtualKey.Control or VirtualKey.Menu or VirtualKey.Shift or VirtualKey.LeftWindows or VirtualKey.RightWindows
            or VirtualKey.LeftControl or VirtualKey.RightControl or VirtualKey.LeftMenu or VirtualKey.RightMenu or VirtualKey.LeftShift or VirtualKey.RightShift)
            return;
        e.Handled = true;
        if (key == VirtualKey.Escape)
        {
            _listening = false;
            ShowKeys();
            return;
        }
        bool Down(VirtualKey k) => InputKeyboardSource.GetKeyStateForCurrentThread(k).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        uint mods = (Down(VirtualKey.Menu) ? 1u : 0) | (Down(VirtualKey.Control) ? 2u : 0) | (Down(VirtualKey.Shift) ? 4u : 0);
        // A hotkey needs Ctrl or Alt, or it would take a key away from typing.
        if ((mods & 3) == 0) return;
        if (_hold(mods, (uint)key))
        {
            _settings.HotkeyModifiers = mods;
            _settings.HotkeyKey = (uint)key;
            _settings.Save();
        }
        else
        {
            _note.Text = _t.HotkeyTaken;
            _hold(_settings.HotkeyModifiers, _settings.HotkeyKey);
        }
        _listening = false;
        ShowKeys();
    }
}
