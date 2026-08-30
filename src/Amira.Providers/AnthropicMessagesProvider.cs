using System.Runtime.CompilerServices;
using System.Text.Json;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Providers;

public sealed class AnthropicMessagesProvider : IModelProvider, IDisposable
{
    private const int DefaultMaxTokens = 1024;
    private readonly ProviderTransport transport;
    private readonly ICredentialResolver credentials;
    private readonly bool ownsTransport;

    /// <summary>Creates a provider with a reusable transport that rejects redirects.</summary>
    public AnthropicMessagesProvider(ICredentialResolver credentials)
    {
        ArgumentNullException.ThrowIfNull(credentials);
        transport = ProviderTransport.CreateSecureDefault();
        this.credentials = credentials;
        ownsTransport = true;
    }

    /// <summary>Creates a provider using a caller-owned transport.</summary>
    public AnthropicMessagesProvider(ProviderTransport transport, ICredentialResolver credentials)
    {
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentNullException.ThrowIfNull(credentials);
        this.transport = transport;
        this.credentials = credentials;
        ownsTransport = false;
    }

    public ProviderProtocol Protocol => ProviderProtocol.AnthropicMessages;

    public async IAsyncEnumerable<ModelStreamEvent> StreamAsync(
        ProviderConnection connection,
        ModelRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        request.ValidateConnection(connection);
        string credential = await ProviderHttp.ResolveCredentialAsync(credentials, connection, cancellationToken).ConfigureAwait(false);
        var generation = request.ModelProfile.GenerationOptions;
        var dto = new AnthropicRequestDto
        {
            Model = request.ModelProfile.Model,
            MaxTokens = generation.MaxOutputTokens ?? DefaultMaxTokens,
            System = request.SystemInstruction,
            Messages = [.. request.Messages.Select(message => new AnthropicMessageDto
            {
                Role = message.Role == ModelMessageRole.User ? "user" : "assistant",
                Content = message.Content
            })],
            Stream = true,
            Temperature = generation.Temperature
        };
        using var httpRequest = ProviderHttp.CreateRequest(
            HttpMethod.Post,
            ProviderHttp.Endpoint(connection, "v1/messages"),
            JsonSerializer.SerializeToUtf8Bytes(dto, ProviderJsonContext.Default.AnthropicRequestDto),
            connection,
            credential,
            anthropic: true);
        using var response = await ProviderHttp.SendAsync(transport, httpRequest, cancellationToken).ConfigureAwait(false);

        yield return new ModelStreamEvent.Started();
        bool terminal = false;
        int? inputTokens = null;
        int? outputTokens = null;
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        await using (var enumerator = SseParser.ParseAsync(stream, cancellationToken).GetAsyncEnumerator(cancellationToken))
        {
            while (await ProviderHttp.MoveNextSseAsync(enumerator).ConfigureAwait(false))
            {
                var item = enumerator.Current;
                if (item.Data.Trim().Equals("[DONE]", StringComparison.Ordinal))
                {
                    terminal = true;
                    break;
                }
                if (item.EventName is not null && !IsKnownEvent(item.EventName)) continue;
                if (string.IsNullOrWhiteSpace(item.Data)) continue;
                AnthropicEventDto eventDto;
                try
                {
                    eventDto = JsonSerializer.Deserialize(item.Data, ProviderJsonContext.Default.AnthropicEventDto)
                        ?? throw new JsonException();
                }
                catch (JsonException)
                {
                    throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream contained invalid JSON.");
                }

                switch (eventDto.Type)
                {
                    case "message_start":
                        ApplyUsage(eventDto.Message?.Usage, ref inputTokens, ref outputTokens);
                        break;
                    case "content_block_delta" when eventDto.Delta?.Type == "text_delta":
                        if (!string.IsNullOrEmpty(eventDto.Delta.Text)) yield return new ModelStreamEvent.TextDelta(eventDto.Delta.Text);
                        break;
                    case "message_delta":
                        ApplyUsage(eventDto.Usage, ref inputTokens, ref outputTokens);
                        break;
                    case "message_stop":
                        terminal = true;
                        break;
                    case "error":
                        throw Failure(eventDto.Error);
                    case "content_block_start" when eventDto.ContentBlock?.Type == "tool_use":
                        throw ProviderHttp.Failure(AmiraErrorCodes.UnsupportedOutput, "The provider returned unsupported tool output.");
                }
                if (terminal) break;
            }
        }

        if (!terminal) throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream ended before completion.");
        if (inputTokens is not null || outputTokens is not null)
            yield return new ModelStreamEvent.Usage(new ProviderUsage(inputTokens, outputTokens));
        yield return new ModelStreamEvent.Completed();
    }

    private static void ApplyUsage(AnthropicUsageDto? value, ref int? inputTokens, ref int? outputTokens)
    {
        if (value is null) return;
        if (value.InputTokens is not null || value.CacheCreationInputTokens is not null || value.CacheReadInputTokens is not null)
            inputTokens = (value.InputTokens ?? 0) + (value.CacheCreationInputTokens ?? 0) + (value.CacheReadInputTokens ?? 0);
        if (value.OutputTokens is not null) outputTokens = value.OutputTokens;
    }

    private static AmiraException Failure(ProviderErrorDetailDto? error) =>
        ProviderHttp.Failure(ProviderHttp.MapErrorCode(error?.Type, AmiraErrorCodes.ProviderStreamError), "The provider stream returned an error.", ProviderHttp.IsTransientCode(error?.Type));

    private static bool IsKnownEvent(string eventName) => eventName is "message_start" or "content_block_start" or "content_block_delta" or "message_delta" or "message_stop" or "error";

    public void Dispose()
    {
        if (ownsTransport) transport.Dispose();
    }
}
