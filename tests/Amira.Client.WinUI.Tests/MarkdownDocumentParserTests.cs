using Amira.Client.WinUI;

namespace Amira.Client.WinUI.Tests;

public sealed class MarkdownDocumentParserTests
{
    [Fact]
    public void Parse_projects_supported_blocks_and_inline_formatting()
    {
        MarkdownDocumentProjection document = MarkdownDocumentParser.Parse("""
            # Heading

            A **bold** and *italic* [link](https://example.com) with `code`.

            - first
            - second

            3. third

            > quoted

            ```csharp
            Console.WriteLine("hello");
            ```
            """);

        MarkdownHeadingProjection heading = Assert.IsType<MarkdownHeadingProjection>(document.Blocks[0]);
        Assert.Equal(1, heading.Level);
        MarkdownParagraphProjection paragraph = Assert.IsType<MarkdownParagraphProjection>(document.Blocks[1]);
        Assert.Contains(paragraph.Inlines, inline => inline is MarkdownEmphasisProjection { IsStrong: true });
        Assert.Contains(paragraph.Inlines, inline => inline is MarkdownEmphasisProjection { IsStrong: false });
        Assert.Contains(paragraph.Inlines, inline => inline is MarkdownLinkProjection { Url: "https://example.com" });
        Assert.Contains(paragraph.Inlines, inline => inline is MarkdownCodeProjection { Code: "code" });
        Assert.IsType<MarkdownListProjection>(document.Blocks[2]);
        MarkdownListProjection ordered = Assert.IsType<MarkdownListProjection>(document.Blocks[3]);
        Assert.True(ordered.IsOrdered);
        Assert.Equal(3, ordered.Start);
        Assert.IsType<MarkdownQuoteProjection>(document.Blocks[4]);
        MarkdownCodeBlockProjection code = Assert.IsType<MarkdownCodeBlockProjection>(document.Blocks[5]);
        Assert.Equal("csharp", code.Language);
        Assert.Contains("Console.WriteLine", code.Code, StringComparison.Ordinal);
    }

    [Fact]
    public void Parse_disables_raw_html_without_creating_an_executable_projection()
    {
        MarkdownDocumentProjection document = MarkdownDocumentParser.Parse("<script>alert('unsafe')</script>\n\n<a href=\"javascript:alert(1)\">unsafe</a>");

        Assert.All(document.Blocks, block => Assert.IsNotType<MarkdownCodeBlockProjection>(block));
        IEnumerable<MarkdownTextProjection> text = document.Blocks
            .OfType<MarkdownParagraphProjection>()
            .SelectMany(static paragraph => paragraph.Inlines)
            .OfType<MarkdownTextProjection>();
        Assert.Contains(text, item => item.Text.Contains("script", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(document.Blocks.OfType<MarkdownParagraphProjection>().SelectMany(static paragraph => paragraph.Inlines), inline => inline is MarkdownLinkProjection { Url: var url } && url.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase));
    }
}
