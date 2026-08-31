using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace Amira.Client.WinUI;

public sealed record MarkdownDocumentProjection(IReadOnlyList<MarkdownBlockProjection> Blocks);

public abstract record MarkdownBlockProjection;
public sealed record MarkdownParagraphProjection(IReadOnlyList<MarkdownInlineProjection> Inlines) : MarkdownBlockProjection;
public sealed record MarkdownHeadingProjection(int Level, IReadOnlyList<MarkdownInlineProjection> Inlines) : MarkdownBlockProjection;
public sealed record MarkdownListProjection(bool IsOrdered, int Start, IReadOnlyList<IReadOnlyList<MarkdownBlockProjection>> Items) : MarkdownBlockProjection;
public sealed record MarkdownQuoteProjection(IReadOnlyList<MarkdownBlockProjection> Blocks) : MarkdownBlockProjection;
public sealed record MarkdownCodeBlockProjection(string Code, string? Language) : MarkdownBlockProjection;

public abstract record MarkdownInlineProjection;
public sealed record MarkdownTextProjection(string Text) : MarkdownInlineProjection;
public sealed record MarkdownEmphasisProjection(bool IsStrong, IReadOnlyList<MarkdownInlineProjection> Children) : MarkdownInlineProjection;
public sealed record MarkdownCodeProjection(string Code) : MarkdownInlineProjection;
public sealed record MarkdownLinkProjection(string Text, string Url) : MarkdownInlineProjection;
public sealed record MarkdownLineBreakProjection : MarkdownInlineProjection;

public static class MarkdownDocumentParser
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder().DisableHtml().Build();

    public static MarkdownDocumentProjection Parse(string markdown)
    {
        MarkdownDocument document = Markdown.Parse(markdown, Pipeline);
        return new MarkdownDocumentProjection(document.Select(ProjectBlock).Where(static block => block is not null).Cast<MarkdownBlockProjection>().ToArray());
    }

    private static MarkdownBlockProjection? ProjectBlock(Block block) => block switch
    {
        HeadingBlock heading => new MarkdownHeadingProjection(heading.Level, ProjectInlines(heading.Inline)),
        ParagraphBlock paragraph => new MarkdownParagraphProjection(ProjectInlines(paragraph.Inline)),
        ListBlock list => new MarkdownListProjection(list.IsOrdered, list.IsOrdered ? int.Parse(list.OrderedStart!) : 1, list.OfType<ListItemBlock>().Select(ProjectListItem).ToArray()),
        QuoteBlock quote => new MarkdownQuoteProjection(quote.Select(ProjectBlock).Where(static child => child is not null).Cast<MarkdownBlockProjection>().ToArray()),
        FencedCodeBlock fenced => new MarkdownCodeBlockProjection(fenced.Lines.ToString(), fenced.Info),
        CodeBlock code => new MarkdownCodeBlockProjection(code.Lines.ToString(), null),
        HtmlBlock => null,
        _ => null
    };

    private static IReadOnlyList<MarkdownBlockProjection> ProjectListItem(ListItemBlock item) => item
        .Select(ProjectBlock)
        .Where(static block => block is not null)
        .Cast<MarkdownBlockProjection>()
        .ToArray();

    private static IReadOnlyList<MarkdownInlineProjection> ProjectInlines(ContainerInline? container)
    {
        if (container is null) return [];

        List<MarkdownInlineProjection> projections = [];
        for (Inline? inline = container.FirstChild; inline is not null; inline = inline.NextSibling)
        {
            MarkdownInlineProjection? projection = inline switch
            {
                LiteralInline literal => new MarkdownTextProjection(literal.Content.ToString()),
                CodeInline code => new MarkdownCodeProjection(code.Content),
                EmphasisInline emphasis => new MarkdownEmphasisProjection(emphasis.DelimiterCount >= 2, ProjectInlines(emphasis)),
                LinkInline { IsImage: false } link => new MarkdownLinkProjection(InlineText(link), link.Url ?? string.Empty),
                LineBreakInline => new MarkdownLineBreakProjection(),
                HtmlInline => null,
                _ => null
            };
            if (projection is not null) projections.Add(projection);
        }
        return projections;
    }

    private static string InlineText(ContainerInline container) => string.Concat(ProjectInlines(container).Select(InlineText));

    private static string InlineText(MarkdownInlineProjection inline) => inline switch
    {
        MarkdownTextProjection text => text.Text,
        MarkdownCodeProjection code => code.Code,
        MarkdownEmphasisProjection emphasis => string.Concat(emphasis.Children.Select(InlineText)),
        MarkdownLinkProjection link => link.Text,
        MarkdownLineBreakProjection => Environment.NewLine,
        _ => string.Empty
    };
}
