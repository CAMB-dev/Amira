using Amira.Client.WinUI;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Client.WinUI.Tests;

public sealed class ActivityDetailDisplayConverterTests
{
    [Theory]
    [InlineData(ProviderProtocol.OpenAIChatCompatible, "OpenAI Chat Compatible")]
    [InlineData(ProviderProtocol.OpenAIResponses, "OpenAI Responses")]
    [InlineData(ProviderProtocol.AnthropicMessages, "Anthropic Messages")]
    public void Provider_protocol_converter_uses_the_connection_display_labels(ProviderProtocol protocol, string expected)
    {
        ProviderProtocolTextConverter converter = new();

        Assert.Equal(expected, converter.Convert(protocol, typeof(string), null!, string.Empty));
    }

    [Fact]
    public void Failure_detail_converter_exposes_only_stable_error_metadata()
    {
        TurnFailureDetailConverter converter = new();
        AmiraError failure = new("provider_rate_limited", ErrorCategory.Provider, "Try again later.");

        Assert.Equal("Provider", converter.Convert(failure, typeof(string), "category", string.Empty));
        Assert.Equal("provider_rate_limited", converter.Convert(failure, typeof(string), "code", string.Empty));
    }

    [Fact]
    public void Failure_detail_converter_rejects_unknown_parameters()
    {
        TurnFailureDetailConverter converter = new();

        Assert.Throws<ArgumentOutOfRangeException>(() => { converter.Convert(default(AmiraError), typeof(string), "message", string.Empty); });
    }
}
