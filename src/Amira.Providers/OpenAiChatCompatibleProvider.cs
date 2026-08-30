using System.Runtime.CompilerServices;
using System.Text.Json;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Providers;

public sealed class OpenAiChatCompatibleProvider : IModelProvider, IDisposable
{
    private readonly ProviderTransport transport;
    private readonly ICredentialResolver credentials;
    private readonly bool ownsTransport;

    /// <summary>Creates a provider with a reusable transport that rejects redirects.</summary>
    public OpenAiChatCompatibleProvider(ICredentialResolver credentials)
    {
        ArgumentNullException.ThrowIfNull(credentials);
        transport = ProviderTransport.CreateSecureDefault();
        this.credentials = credentials;
        ownsTransport = true;
    }

    /// <summary>Creates a provider using a caller-owned transport.</summary>
    public OpenAiChatCompatibleProvider(ProviderTransport transport, ICredentialResolver credentials)
    {
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentNullException.ThrowIfNull(credentials);
        this.transport = transport;
        this.credentials = credentials;
        ownsTransport = false;
    }

    public ProviderProtocol Protocol => ProviderProtocol.OpenAIChatCompatible;

    public async IAsyncEnumerable<ModelStreamEvent> StreamAsync(
        ProviderConnection connection,
        ModelRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        request.ValidateConnection(connection);
        var options = request.ModelProfile.ProviderOptions;
        bool useMaxCompletionTokens = GetBoolean(options, "use_max_completion_tokens", false);
        bool includeUsage = GetBoolean(options, "include_usage", false);
        string credential = await ProviderHttp.ResolveCredentialAsync(credentials, connection, cancellationToken).ConfigureAwait(false);
        var dto = new ChatRequestDto
        {
            Model = request.ModelProfile.Model,
            Messages = BuildMessages(request),
            Stream = true,
            StreamOptions = includeUsage ? new ChatStreamOptionsDto { IncludeUsage = true } : null,
            Temperature = request.ModelProfile.GenerationOptions.Temperature,
            MaxCompletionTokens = useMaxCompletionTokens ? request.ModelProfile.GenerationOptions.MaxOutputTokens : null,
            MaxTokens = useMaxCompletionTokens ? null : request.ModelProfile.GenerationOptions.MaxOutputTokens
        };
        using var httpRequest = ProviderHttp.CreateRequest(
            HttpMethod.Post,
            ProviderHttp.Endpoint(connection, "chat/completions"),
            JsonSerializer.SerializeToUtf8Bytes(dto, ProviderJsonContext.Default.ChatRequestDto),
            connection,
            credential,
            anthropic: false);
        using var response = await ProviderHttp.SendAsync(transport, httpRequest, cancellationToken).ConfigureAwait(false);

        yield return new ModelStreamEvent.Started();
        bool finishReceived = false;
        bool doneReceived = false;
        ProviderUsage? usage = null;
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using (var enumerator = SseParser.ParseAsync(stream, cancellationToken).GetAsyncEnumerator(cancellationToken))
        {
            while (await ProviderHttp.MoveNextSseAsync(enumerator).ConfigureAwait(false))
            {
                var item = enumerator.Current;
                if (item.Data.Trim().Equals("[DONE]", StringComparison.Ordinal))
                {
                    doneReceived = true;
                    break;
                }
                if (item.EventName is not null && !item.EventName.Equals("message", StringComparison.Ordinal)) continue;
                if (string.IsNullOrWhiteSpace(item.Data)) continue;
                ChatChunkDto chunk;
                try
                {
                    chunk = JsonSerializer.Deserialize(item.Data, ProviderJsonContext.Default.ChatChunkDto)
                        ?? throw new JsonException();
                }
                catch (JsonException)
                {
                    throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream contained invalid JSON.");
                }

                ChatChoiceDto[] choices = chunk.Choices ?? [];
                if (chunk.Usage is { } chunkUsage)
                {
                    if (usage is not null || choices.Length != 0)
                        throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream contained invalid event ordering.");
                    usage = new ProviderUsage(chunkUsage.PromptTokens, chunkUsage.CompletionTokens);
                    continue;
                }

                foreach (var choice in choices)
                {
                    if (choice.Index != 0) continue;
                    if (finishReceived || usage is not null)
                        throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream contained invalid event ordering.");
                    if (!string.IsNullOrEmpty(choice.Delta?.Content)) yield return new ModelStreamEvent.TextDelta(choice.Delta.Content);
                    if (!string.IsNullOrEmpty(choice.Delta?.Refusal)) yield return new ModelStreamEvent.TextDelta(choice.Delta.Refusal);
                    if (choice.FinishReason is not null) finishReceived = true;
                }
            }
        }

        if (!doneReceived && !finishReceived)
            throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream ended before completion.");
        if (usage is not null) yield return new ModelStreamEvent.Usage(usage);
        yield return new ModelStreamEvent.Completed();
    }

    private static ChatMessageDto[] BuildMessages(ModelRequest request)
    {
        var messages = new List<ChatMessageDto>(request.Messages.Count + 1);
        if (!string.IsNullOrEmpty(request.SystemInstruction))
            messages.Add(new ChatMessageDto { Role = "system", Content = request.SystemInstruction });
        foreach (var message in request.Messages)
            messages.Add(new ChatMessageDto { Role = message.Role == ModelMessageRole.User ? "user" : "assistant", Content = message.Content });
        return [.. messages];
    }

    private static bool GetBoolean(IReadOnlyDictionary<string, string> options, string key, bool fallback) =>
        options.TryGetValue(key, out var value) && bool.TryParse(value, out var parsed) ? parsed : fallback;

    public void Dispose()
    {
        if (ownsTransport) transport.Dispose();
    }
}
