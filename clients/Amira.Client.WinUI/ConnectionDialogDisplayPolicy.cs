using Amira.Domain;

namespace Amira.Client.WinUI;

public readonly record struct ConnectionProtocolOption(ProviderProtocol Protocol, string DisplayName);

public enum ConnectionManagerAction
{
    Add,
    Edit
}

public static class ConnectionDialogDisplayPolicy
{
    public static IReadOnlyList<ConnectionProtocolOption> Protocols { get; } =
    [
        new(ProviderProtocol.OpenAIChatCompatible, ProtocolLabel(ProviderProtocol.OpenAIChatCompatible)),
        new(ProviderProtocol.OpenAIResponses, ProtocolLabel(ProviderProtocol.OpenAIResponses)),
        new(ProviderProtocol.AnthropicMessages, ProtocolLabel(ProviderProtocol.AnthropicMessages))
    ];

    public static string ProtocolLabel(ProviderProtocol protocol) => protocol switch
    {
        ProviderProtocol.OpenAIChatCompatible => "OpenAI Chat Compatible",
        ProviderProtocol.OpenAIResponses => "OpenAI Responses",
        ProviderProtocol.AnthropicMessages => "Anthropic Messages",
        _ => throw new ArgumentOutOfRangeException(nameof(protocol), protocol, "Unsupported provider protocol.")
    };

    public static string EnabledLabel(bool enabled) => enabled ? "Enabled" : "Disabled";

    public static ConnectionManagerAction? ResolveManagerAction(bool addRequested, bool editRequested, bool hasSelection) => addRequested
        ? ConnectionManagerAction.Add
        : editRequested && hasSelection ? ConnectionManagerAction.Edit : null;
}
