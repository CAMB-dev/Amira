using Amira.Domain;
using Amira.Errors;

namespace Amira.Client.WinUI;

public sealed record ConnectionDraft(
    ProviderProtocol Protocol,
    string DisplayName,
    string BaseUrl,
    string? DefaultModel,
    bool Enabled,
    ProviderConnection? Editing = null)
{
    public static ConnectionDraft ForCreate(ProviderProtocol protocol = ProviderProtocol.OpenAIResponses) =>
        ConnectionDraftPolicy.ForCreate(protocol);

    public static ConnectionDraft ForEdit(ProviderConnection connection) =>
        ConnectionDraftPolicy.ForEdit(connection);
}

public sealed record ValidatedConnectionDraft(
    ProviderProtocol Protocol,
    string DisplayName,
    Uri BaseUrl,
    string? DefaultModel,
    bool Enabled,
    ProviderConnection? Editing);

public static class ConnectionDraftPolicy
{
    public static ConnectionDraft ForCreate(ProviderProtocol protocol) =>
        new(protocol, string.Empty, string.Empty, null, Enabled: true);

    public static ConnectionDraft ForEdit(ProviderConnection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        return new ConnectionDraft(
            connection.Protocol,
            connection.DisplayName,
            connection.BaseUrl.AbsoluteUri,
            connection.DefaultModel,
            connection.Enabled,
            connection);
    }

    public static ValidatedConnectionDraft Validate(ConnectionDraft draft)
    {
        ArgumentNullException.ThrowIfNull(draft);
        if (string.IsNullOrWhiteSpace(draft.DisplayName))
            throw ProductError(AmiraErrorCodes.TextRequired, ErrorCategory.Input, "A connection display name is required.");
        if (!Uri.TryCreate(draft.BaseUrl, UriKind.Absolute, out Uri? baseUrl)
            || (baseUrl.Scheme != Uri.UriSchemeHttps
                && !(baseUrl.Scheme == Uri.UriSchemeHttp && baseUrl.IsLoopback))
            || !string.IsNullOrEmpty(baseUrl.UserInfo)
            || !string.IsNullOrEmpty(baseUrl.Query)
            || !string.IsNullOrEmpty(baseUrl.Fragment))
        {
            throw ProductError(
                AmiraErrorCodes.InvalidProviderEndpoint,
                ErrorCategory.Configuration,
                "The provider endpoint must be absolute HTTPS, or loopback HTTP, without user information, query, or fragment.");
        }

        return new ValidatedConnectionDraft(
            draft.Editing?.Protocol ?? draft.Protocol,
            draft.DisplayName.Trim(),
            baseUrl,
            string.IsNullOrWhiteSpace(draft.DefaultModel) ? null : draft.DefaultModel.Trim(),
            draft.Enabled,
            draft.Editing);
    }

    public static void RequireCreateSecret(ConnectionDraft draft, string? secret)
    {
        ArgumentNullException.ThrowIfNull(draft);
        if (draft.Editing is null && string.IsNullOrWhiteSpace(secret))
            throw ProductError(AmiraErrorCodes.CredentialMissing, ErrorCategory.Input, "An API key is required for a new connection.");
    }

    private static AmiraException ProductError(string code, ErrorCategory category, string message) =>
        new(new AmiraError(code, category, message));
}
