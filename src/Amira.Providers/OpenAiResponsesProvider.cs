using System.Runtime.CompilerServices;
using System.Text.Json;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Providers;

public sealed class OpenAiResponsesProvider : IModelProvider, IDisposable
{
    private readonly ProviderTransport transport;
    private readonly ICredentialResolver credentials;
    private readonly bool ownsTransport;

    /// <summary>Creates a provider with a reusable transport that rejects redirects.</summary>
    public OpenAiResponsesProvider(ICredentialResolver credentials)
    {
        ArgumentNullException.ThrowIfNull(credentials);
        transport = ProviderTransport.CreateSecureDefault();
        this.credentials = credentials;
        ownsTransport = true;
    }

    /// <summary>Creates a provider using a caller-owned transport.</summary>
    public OpenAiResponsesProvider(ProviderTransport transport, ICredentialResolver credentials)
    {
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentNullException.ThrowIfNull(credentials);
        this.transport = transport;
        this.credentials = credentials;
        ownsTransport = false;
    }

    public ProviderProtocol Protocol => ProviderProtocol.OpenAIResponses;

    public async IAsyncEnumerable<ModelStreamEvent> StreamAsync(
        ProviderConnection connection,
        ModelRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        request.ValidateConnection(connection);
        string credential = await ProviderHttp.ResolveCredentialAsync(credentials, connection, cancellationToken).ConfigureAwait(false);
        var dto = new ResponsesRequestDto
        {
            Model = request.ModelProfile.Model,
            Instructions = request.SystemInstruction,
            Input = [.. request.Messages.Select(message => new ResponsesInputDto
            {
                Role = message.Role == ModelMessageRole.User ? "user" : "assistant",
                Content = [new ResponsesTextDto { Text = message.Content }]
            })],
            Stream = true,
            Store = false,
            Temperature = request.ModelProfile.GenerationOptions.Temperature,
            MaxOutputTokens = request.ModelProfile.GenerationOptions.MaxOutputTokens
        };
        using var httpRequest = ProviderHttp.CreateRequest(
            HttpMethod.Post,
            ProviderHttp.Endpoint(connection, "responses"),
            JsonSerializer.SerializeToUtf8Bytes(dto, ProviderJsonContext.Default.ResponsesRequestDto),
            connection,
            credential,
            anthropic: false);
        using var response = await ProviderHttp.SendAsync(transport, httpRequest, cancellationToken).ConfigureAwait(false);

        yield return new ModelStreamEvent.Started();
        bool terminal = false;
        ProviderUsage? usage = null;
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
                ResponsesEventDto eventDto;
                try
                {
                    eventDto = JsonSerializer.Deserialize(item.Data, ProviderJsonContext.Default.ResponsesEventDto)
                        ?? throw new JsonException();
                }
                catch (JsonException)
                {
                    throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream contained invalid JSON.");
                }

                switch (eventDto.Type)
                {
                    case "response.output_text.delta":
                    case "response.refusal.delta":
                        if (!string.IsNullOrEmpty(eventDto.Delta)) yield return new ModelStreamEvent.TextDelta(eventDto.Delta);
                        break;
                    case "response.completed":
                        usage = ToUsage(eventDto.Response?.Usage);
                        terminal = true;
                        break;
                    case "response.failed":
                        throw Failure(eventDto.Response?.Error, false);
                    case "response.incomplete":
                        throw ProviderHttp.Failure(AmiraErrorCodes.ResponseIncomplete, "The provider response was incomplete.");
                    case "error":
                        throw ProviderHttp.Failure(
                            ProviderHttp.MapErrorCode(eventDto.Code, "provider_stream_error"),
                            "The provider stream returned an error.");
                }
                if (terminal) break;
            }
        }

        if (!terminal) throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream ended before completion.");
        if (usage is not null) yield return new ModelStreamEvent.Usage(usage);
        yield return new ModelStreamEvent.Completed();
    }

    private static ProviderUsage? ToUsage(ResponsesUsageDto? value) =>
        value is null ? null : new ProviderUsage(value.InputTokens, value.OutputTokens);

    private static AmiraException Failure(ProviderErrorDetailDto? error, bool transient) =>
        ProviderHttp.Failure(ProviderHttp.MapErrorCode(error?.Code, AmiraErrorCodes.ProviderStreamError), "The provider response failed.", transient || ProviderHttp.IsTransientCode(error?.Code));

    private static bool IsKnownEvent(string eventName) => eventName is "response.output_text.delta" or "response.refusal.delta" or "response.completed" or "response.failed" or "response.incomplete" or "error";

    public void Dispose()
    {
        if (ownsTransport) transport.Dispose();
    }
}
