using Amira.Client.WinUI;
using Amira.Domain;

namespace Amira.Client.WinUI.Tests;

public sealed class ConnectionDialogDisplayPolicyTests
{
    [Theory]
    [InlineData(ProviderProtocol.OpenAIChatCompatible, "OpenAI Chat Compatible")]
    [InlineData(ProviderProtocol.OpenAIResponses, "OpenAI Responses")]
    [InlineData(ProviderProtocol.AnthropicMessages, "Anthropic Messages")]
    public void Protocol_labels_are_friendly(ProviderProtocol protocol, string expected)
    {
        Assert.Equal(expected, ConnectionDialogDisplayPolicy.ProtocolLabel(protocol));
    }

    [Fact]
    public void Invalid_protocol_is_a_programmer_error()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => ConnectionDialogDisplayPolicy.ProtocolLabel((ProviderProtocol)999));
    }

    [Theory]
    [InlineData(true, "Enabled")]
    [InlineData(false, "Disabled")]
    public void Enabled_state_is_explicit(bool enabled, string expected)
    {
        Assert.Equal(expected, ConnectionDialogDisplayPolicy.EnabledLabel(enabled));
    }

    [Theory]
    [InlineData(true, false, false, ConnectionManagerAction.Add)]
    [InlineData(true, true, true, ConnectionManagerAction.Add)]
    [InlineData(false, true, true, ConnectionManagerAction.Edit)]
    public void Manager_actions_are_explicit(bool addRequested, bool editRequested, bool hasSelection, ConnectionManagerAction expected)
    {
        Assert.Equal(expected, ConnectionDialogDisplayPolicy.ResolveManagerAction(addRequested, editRequested, hasSelection));
    }

    [Fact]
    public void Close_and_edit_without_selection_do_not_start_an_action()
    {
        Assert.Null(ConnectionDialogDisplayPolicy.ResolveManagerAction(addRequested: false, editRequested: false, hasSelection: true));
        Assert.Null(ConnectionDialogDisplayPolicy.ResolveManagerAction(addRequested: false, editRequested: true, hasSelection: false));
    }
}
