using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Shapes;

namespace Amira.Client.WinUI;

public sealed class ResponseLoadingIndicator : StackPanel
{
    private readonly TextBlock _status;
    private readonly Ellipse[] _dots;
    private Storyboard? _storyboard;

    public static readonly DependencyProperty AccentBrushProperty = DependencyProperty.Register(
        nameof(AccentBrush),
        typeof(Brush),
        typeof(ResponseLoadingIndicator),
        new PropertyMetadata(null, OnAccentBrushChanged));

    public ResponseLoadingIndicator()
    {
        Orientation = Orientation.Horizontal;
        Spacing = 8;
        VerticalAlignment = VerticalAlignment.Center;
        _status = new TextBlock { Text = "Responding…", FontSize = 14, VerticalAlignment = VerticalAlignment.Center };
        _dots = [CreateDot(), CreateDot(), CreateDot()];
        StackPanel dotPanel = new() { Orientation = Orientation.Horizontal, Spacing = 5, VerticalAlignment = VerticalAlignment.Center };
        foreach (Ellipse dot in _dots)
        {
            AutomationProperties.SetAccessibilityView(dot, AccessibilityView.Raw);
            dotPanel.Children.Add(dot);
        }
        Children.Add(_status);
        Children.Add(dotPanel);
        AutomationProperties.SetName(this, "Responding");
        AutomationProperties.SetLiveSetting(_status, AutomationLiveSetting.Polite);
        AutomationProperties.SetName(_status, "Responding");
        Loaded += ResponseLoadingIndicatorLoaded;
        Unloaded += ResponseLoadingIndicatorUnloaded;
    }

    public Brush? AccentBrush
    {
        get => (Brush?)GetValue(AccentBrushProperty);
        set => SetValue(AccentBrushProperty, value);
    }

    private static void OnAccentBrushChanged(DependencyObject dependencyObject, DependencyPropertyChangedEventArgs args) =>
        ((ResponseLoadingIndicator)dependencyObject).ApplyAccentBrush();

    private static Ellipse CreateDot() => new()
    {
        Width = 6,
        Height = 6,
        Opacity = .58,
        VerticalAlignment = VerticalAlignment.Center
    };

    private void ResponseLoadingIndicatorLoaded(object sender, RoutedEventArgs args)
    {
        ApplyAccentBrush();
        Start(MotionPolicy.Current);
    }

    private void ResponseLoadingIndicatorUnloaded(object sender, RoutedEventArgs args) => Stop();

    private void ApplyAccentBrush()
    {
        _status.Foreground = AccentBrush;
        foreach (Ellipse dot in _dots) dot.Fill = AccentBrush;
    }

    private void Start(MotionSettings motion)
    {
        Stop();
        if (!motion.AnimationsEnabled)
        {
            SetStaticState();
            return;
        }

        Storyboard storyboard = new();
        for (int index = 0; index < _dots.Length; index++)
        {
            DoubleAnimation animation = new()
            {
                From = .35,
                To = 1,
                Duration = new Duration(motion.LoadingPulseDuration),
                BeginTime = TimeSpan.FromTicks(motion.LoadingPhaseOffset.Ticks * index),
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever,
                EnableDependentAnimation = true
            };
            Storyboard.SetTarget(animation, _dots[index]);
            Storyboard.SetTargetProperty(animation, "Opacity");
            storyboard.Children.Add(animation);
        }
        _storyboard = storyboard;
        storyboard.Begin();
    }

    private void Stop()
    {
        _storyboard?.Stop();
        _storyboard = null;
    }

    private void SetStaticState()
    {
        foreach (Ellipse dot in _dots) dot.Opacity = .72;
    }
}
