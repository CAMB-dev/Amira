using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace Amira.Client.WinUI;

public sealed class MarkdownView : StackPanel
{
    private MarkdownDocumentProjection _document = new([]);

    public static readonly DependencyProperty MarkdownProperty = DependencyProperty.Register(
        nameof(Markdown),
        typeof(string),
        typeof(MarkdownView),
        new PropertyMetadata(string.Empty, OnMarkdownChanged));

    public MarkdownView()
    {
        Spacing = 8;
        ActualThemeChanged += MarkdownViewActualThemeChanged;
    }

    public string Markdown
    {
        get => (string)GetValue(MarkdownProperty);
        set => SetValue(MarkdownProperty, value);
    }

    private static void OnMarkdownChanged(DependencyObject dependencyObject, DependencyPropertyChangedEventArgs args) =>
        ((MarkdownView)dependencyObject).SetDocument((string?)args.NewValue ?? string.Empty);

    private void MarkdownViewActualThemeChanged(FrameworkElement sender, object args) => Render();

    private void SetDocument(string markdown)
    {
        _document = MarkdownDocumentParser.Parse(markdown);
        Render();
    }

    private void Render()
    {
        Children.Clear();
        foreach (MarkdownBlockProjection block in _document.Blocks)
        {
            Children.Add(RenderBlock(block));
        }
    }

    private FrameworkElement RenderBlock(MarkdownBlockProjection block) => block switch
    {
        MarkdownHeadingProjection heading => RenderRichText(heading.Inlines, HeadingSize(heading.Level), new Windows.UI.Text.FontWeight { Weight = 600 }),
        MarkdownParagraphProjection paragraph => RenderRichText(paragraph.Inlines, 17, new Windows.UI.Text.FontWeight { Weight = 400 }),
        MarkdownListProjection list => RenderList(list),
        MarkdownQuoteProjection quote => RenderQuote(quote),
        MarkdownCodeBlockProjection code => RenderCodeBlock(code),
        _ => new TextBlock()
    };

    private StackPanel RenderList(MarkdownListProjection list)
    {
        StackPanel panel = new() { Spacing = 6 };
        for (int index = 0; index < list.Items.Count; index++)
        {
            Grid item = new();
            item.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(28) });
            item.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            item.Children.Add(new TextBlock
            {
                Text = list.IsOrdered ? $"{list.Start + index}." : "•",
                FontSize = 17,
                VerticalAlignment = VerticalAlignment.Top
            });
            StackPanel content = new() { Spacing = 5 };
            foreach (MarkdownBlockProjection child in list.Items[index]) content.Children.Add(RenderBlock(child));
            Grid.SetColumn(content, 1);
            item.Children.Add(content);
            panel.Children.Add(item);
        }
        return panel;
    }

    private Border RenderQuote(MarkdownQuoteProjection quote)
    {
        StackPanel content = new() { Spacing = 7 };
        foreach (MarkdownBlockProjection child in quote.Blocks) content.Children.Add(RenderBlock(child));
        return new Border
        {
            BorderBrush = new SolidColorBrush(AccentColor()),
            BorderThickness = new Thickness(3, 0, 0, 0),
            Padding = new Thickness(12, 2, 0, 2),
            Child = content
        };
    }

    private Border RenderCodeBlock(MarkdownCodeBlockProjection code)
    {
        StackPanel content = new() { Spacing = 5 };
        if (!string.IsNullOrWhiteSpace(code.Language))
        {
            content.Children.Add(new TextBlock { Text = code.Language, FontSize = 12, Opacity = .7 });
        }
        content.Children.Add(new TextBlock
        {
            Text = code.Code,
            FontFamily = new FontFamily("Cascadia Mono"),
            FontSize = 14,
            TextWrapping = TextWrapping.Wrap
        });
        return new Border
        {
            Background = new SolidColorBrush(CodeBackgroundColor()),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12),
            Child = content
        };
    }

    private RichTextBlock RenderRichText(IReadOnlyList<MarkdownInlineProjection> inlines, double fontSize, Windows.UI.Text.FontWeight fontWeight)
    {
        RichTextBlock block = new() { FontSize = fontSize, FontWeight = fontWeight, TextWrapping = TextWrapping.Wrap, LineHeight = fontSize >= 17 ? 26 : 22 };
        Paragraph paragraph = new();
        foreach (MarkdownInlineProjection inline in inlines) AddInline(paragraph.Inlines, inline);
        block.Blocks.Add(paragraph);
        return block;
    }

    private void AddInline(InlineCollection destination, MarkdownInlineProjection inline)
    {
        switch (inline)
        {
            case MarkdownTextProjection text:
                destination.Add(new Run { Text = text.Text });
                break;
            case MarkdownCodeProjection code:
                destination.Add(new Run { Text = code.Code, FontFamily = new FontFamily("Cascadia Mono"), Foreground = new SolidColorBrush(AccentColor()) });
                break;
            case MarkdownEmphasisProjection emphasis:
                Span span = new() { FontWeight = emphasis.IsStrong ? new Windows.UI.Text.FontWeight { Weight = 600 } : new Windows.UI.Text.FontWeight { Weight = 400 }, FontStyle = emphasis.IsStrong ? Windows.UI.Text.FontStyle.Normal : Windows.UI.Text.FontStyle.Italic };
                foreach (MarkdownInlineProjection child in emphasis.Children) AddInline(span.Inlines, child);
                destination.Add(span);
                break;
            case MarkdownLinkProjection link when TryGetLaunchUri(link.Url, out Uri? uri):
                Hyperlink hyperlink = new() { Foreground = new SolidColorBrush(AccentColor()), UnderlineStyle = UnderlineStyle.Single };
                hyperlink.Inlines.Add(new Run { Text = link.Text });
                hyperlink.Click += async (_, _) => await Launcher.LaunchUriAsync(uri);
                destination.Add(hyperlink);
                break;
            case MarkdownLinkProjection link:
                destination.Add(new Run { Text = link.Text });
                break;
            case MarkdownLineBreakProjection:
                destination.Add(new LineBreak());
                break;
        }
    }

    private static bool TryGetLaunchUri(string source, out Uri? uri) =>
        Uri.TryCreate(source, UriKind.Absolute, out uri) &&
        (string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) || string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase));

    private double HeadingSize(int level) => level switch { 1 => 26, 2 => 22, _ => 19 };
    private Windows.UI.Color AccentColor() => ActualTheme == ElementTheme.Light
        ? Windows.UI.Color.FromArgb(255, 0, 95, 184)
        : Windows.UI.Color.FromArgb(255, 105, 166, 255);
    private Windows.UI.Color CodeBackgroundColor() => ActualTheme == ElementTheme.Light
        ? Windows.UI.Color.FromArgb(255, 235, 242, 252)
        : Windows.UI.Color.FromArgb(255, 31, 37, 49);
}
