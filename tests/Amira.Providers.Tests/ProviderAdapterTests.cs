using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Amira.Providers;

namespace Amira.Providers.Tests;

public sealed class ProviderAdapterTests
{
    [Fact]
    public async Task Chat_UsesPathPrefixHeadersBodyAndMapsWhitespaceAndUsage()
    {
        var handler = new RecordingHandler(_ => Sse("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"  \"}}]}\r\n\r\n: keepalive\n\nevent: unknown\ndata: {\"ignored\":true}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n", fragmented: true));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiChatCompatibleProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions(0.4, 77));

        var events = await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken));

        Assert.Collection(events,
            e => Assert.IsType<ModelStreamEvent.Started>(e),
            e => Assert.Equal("  ", Assert.IsType<ModelStreamEvent.TextDelta>(e).Text),
            e => Assert.Equal((7, 3), Tokens(Assert.IsType<ModelStreamEvent.Usage>(e))),
            e => Assert.IsType<ModelStreamEvent.Completed>(e));
        Assert.Equal(new Uri("https://example.test/api/chat/completions"), handler.Request!.RequestUri);
        Assert.Equal("Bearer secret-value", handler.Request.Headers.Authorization!.ToString());
        Assert.Equal("text/event-stream", handler.Request.Headers.Accept.Single().MediaType);
        using var json = JsonDocument.Parse(handler.Body!);
        Assert.Equal("gpt-test", json.RootElement.GetProperty("model").GetString());
        Assert.True(json.RootElement.GetProperty("stream").GetBoolean());
        Assert.Equal(77, json.RootElement.GetProperty("max_tokens").GetInt32());
        Assert.Equal(0.4, json.RootElement.GetProperty("temperature").GetDouble());
        Assert.False(json.RootElement.TryGetProperty("max_completion_tokens", out _));
        Assert.False(json.RootElement.TryGetProperty("stream_options", out _));
        Assert.Equal("system", json.RootElement.GetProperty("messages")[0].GetProperty("role").GetString());
        Assert.Equal("hello", json.RootElement.GetProperty("messages")[1].GetProperty("content").GetString());
    }

    [Fact]
    public async Task Responses_ProjectsHistoryAndDoesNotStore()
    {
        const string stream = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\n" +
                              "data: \"delta\":\"hello\"}\n\n" +
                              ": ping\n\n" +
                              "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":11,\"output_tokens\":5}}}\n\n";
        var handler = new RecordingHandler(_ => Sse(stream, fragmented: true));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiResponsesProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIResponses, new GenerationOptions(null, 42));

        var events = await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken));

        Assert.Equal("hello", Assert.IsType<ModelStreamEvent.TextDelta>(events[1]).Text);
        Assert.Equal((11, 5), Tokens(Assert.IsType<ModelStreamEvent.Usage>(events[2])));
        Assert.IsType<ModelStreamEvent.Completed>(events[3]);
        Assert.Equal(new Uri("https://example.test/api/responses"), handler.Request!.RequestUri);
        Assert.Equal("Bearer secret-value", handler.Request.Headers.Authorization!.ToString());
        using var json = JsonDocument.Parse(handler.Body!);
        Assert.False(json.RootElement.GetProperty("store").GetBoolean());
        Assert.True(json.RootElement.GetProperty("stream").GetBoolean());
        Assert.Equal("sys", json.RootElement.GetProperty("instructions").GetString());
        var input = json.RootElement.GetProperty("input");
        Assert.Equal("message", input[0].GetProperty("type").GetString());
        Assert.Equal("user", input[0].GetProperty("role").GetString());
        Assert.Equal("input_text", input[0].GetProperty("content")[0].GetProperty("type").GetString());
    }

    [Fact]
    public async Task Anthropic_UsesVersionAndApiKeyAndDefaultMaxTokens()
    {
        var handler = new RecordingHandler(_ => Sse(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":3,\"cache_read_input_tokens\":4}}}\n\n" +
            "event: ping\ndata: {}\n\n" +
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"x\"}}\n\n" +
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":4}}\n\n" +
            "data: {\"type\":\"message_stop\"}\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new AnthropicMessagesProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.AnthropicMessages, new GenerationOptions());

        var events = await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken));

        Assert.Equal("x", Assert.IsType<ModelStreamEvent.TextDelta>(events[1]).Text);
        Assert.Equal((9, 4), Tokens(Assert.IsType<ModelStreamEvent.Usage>(events[2])));
        Assert.IsType<ModelStreamEvent.Completed>(events[3]);
        Assert.Equal(new Uri("https://example.test/api/v1/messages"), handler.Request!.RequestUri);
        Assert.Equal("secret-value", handler.Request.Headers.GetValues("x-api-key").Single());
        Assert.Equal("2023-06-01", handler.Request.Headers.GetValues("anthropic-version").Single());
        using var json = JsonDocument.Parse(handler.Body!);
        Assert.Equal(1024, json.RootElement.GetProperty("max_tokens").GetInt32());
        Assert.Equal("sys", json.RootElement.GetProperty("system").GetString());
        Assert.False(json.RootElement.TryGetProperty("temperature", out _));
    }

    [Fact]
    public async Task HttpErrorAndStreamFailureAreSanitizedAndNeverRetried()
    {
        var calls = 0;
        var handler = new RecordingHandler(_ =>
        {
            calls++;
            return new HttpResponseMessage(HttpStatusCode.TooManyRequests)
            {
                Content = new StringContent("{\"error\":{\"code\":\"limit\",\"message\":\"secret-value leaked\"}}", Encoding.UTF8, "application/json")
            };
        });
        using var transport = CustomTransport(handler);
        var provider = new OpenAiResponsesProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIResponses, new GenerationOptions());

        var ex = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));

        Assert.Equal(1, calls);
        Assert.Equal("rate_limit", ex.Code);
        Assert.True(ex.IsTransient);
        Assert.DoesNotContain("secret-value", ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests, "rate_limit")]
    [InlineData(HttpStatusCode.ServiceUnavailable, "provider_server_error")]
    public async Task UnknownHttpErrorCodePreservesStatusClassification(HttpStatusCode statusCode, string expectedCode)
    {
        var handler = new RecordingHandler(_ => new HttpResponseMessage(statusCode)
        {
            Content = new StringContent("{\"error\":{\"code\":\"unknown-upstream-code\",\"message\":\"busy\"}}", Encoding.UTF8, "application/json")
        });
        using var transport = CustomTransport(handler);
        var provider = new OpenAiResponsesProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIResponses, new GenerationOptions());

        var exception = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));

        Assert.Equal(expectedCode, exception.Code);
    }

    [Fact]
    public async Task AnthropicToolUseFailsExplicitlyAndCredentialIsNotInMessage()
    {
        var handler = new RecordingHandler(_ => Sse("data: {\"type\":\"content_block_start\",\"content_block\":{ \"type\": \"tool_use\" }}\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new AnthropicMessagesProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.AnthropicMessages, new GenerationOptions());

        var ex = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));

        Assert.Equal("unsupported_output", ex.Code);
        Assert.DoesNotContain("secret-value", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ResponsesMalformedJsonAndPrematureEofFailWithStableProtocolError()
    {
        var malformed = new RecordingHandler(_ => Sse("data: {not-json}\n\n"));
        using var malformedTransport = CustomTransport(malformed);
        var malformedProvider = new OpenAiResponsesProvider(malformedTransport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIResponses, new GenerationOptions());

        var malformedException = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(malformedProvider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));
        Assert.Equal("stream_protocol", malformedException.Code);
        Assert.DoesNotContain("secret-value", malformedException.Message, StringComparison.Ordinal);

        var eof = new RecordingHandler(_ => Sse("data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"));
        using var eofTransport = CustomTransport(eof);
        var eofProvider = new OpenAiResponsesProvider(eofTransport, new FixedCredentials());
        var eofException = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(eofProvider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));
        Assert.Equal("stream_protocol", eofException.Code);
    }

    [Fact]
    public async Task CallerCancellationRemainsOperationCanceledException()
    {
        var handler = new RecordingHandler(_ => Sse("data: [DONE]\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiChatCompatibleProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions());
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await Collect(provider.StreamAsync(connection, request, cancellation.Token)));
    }

    [Theory]
    [InlineData("http://example.test/")]
    [InlineData("https://user:pass@example.test/")]
    [InlineData("https://example.test/?query=1")]
    public void ProviderConnectionRejectsUnsafeBaseUrls(string baseUrl)
    {
        AmiraException exception = Assert.Throws<AmiraException>(() => ProviderConnection.Create(ProviderProtocol.OpenAIResponses, "test", new Uri(baseUrl), CredentialReference.Create("key")));
        Assert.Equal(ErrorCategory.Configuration, exception.Category);
    }

    [Fact]
    public async Task LoopbackHttpAndOrdinaryExtraHeaderAreAllowed()
    {
        var handler = new RecordingHandler(_ => Sse("data: [DONE]\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiResponsesProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIResponses, new GenerationOptions(), new Uri("http://127.0.0.1/prefix/"), new Dictionary<string, string> { ["x-client"] = "test-client" });
        await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken));
        Assert.Equal(new Uri("http://127.0.0.1/prefix/responses"), handler.Request!.RequestUri);
        Assert.Equal("test-client", handler.Request.Headers.GetValues("x-client").Single());
    }

    [Fact]
    public async Task MissingCredentialAndMismatchedConnectionFailBeforeRequest()
    {
        var handler = new RecordingHandler(_ => Sse("data: [DONE]\n\n"));
        using var transport = CustomTransport(handler);
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions());
        var missing = new OpenAiChatCompatibleProvider(transport, new MissingCredentials());
        var missingException = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(missing.StreamAsync(connection, request, TestContext.Current.CancellationToken)));
        Assert.Equal("credential_missing", missingException.Code);
        Assert.Null(handler.Request);
        var mismatchRequest = Request(ProviderProtocol.OpenAIResponses, new GenerationOptions()).Request;
        var mismatch = new OpenAiChatCompatibleProvider(transport, new FixedCredentials());
        var mismatchException = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(mismatch.StreamAsync(connection, mismatchRequest, TestContext.Current.CancellationToken)));
        Assert.Equal(ErrorCategory.DomainRule, mismatchException.Category);
    }

    [Fact]
    public void ProtectedCredentialHeaderIsRejectedByDomainConfiguration()
    {
        AmiraException exception = Assert.Throws<AmiraException>(() => ProviderConnection.Create(ProviderProtocol.OpenAIResponses, "test", new Uri("https://example.test/"), CredentialReference.Create("key"), extraHeaders: new Dictionary<string, string> { ["Authorization"] = "bad" }));
        Assert.Equal("credential_header_not_allowed", exception.Code);
    }

    [Fact]
    public async Task AdapterRejectsProtectedHostHeader()
    {
        var handler = new RecordingHandler(_ => Sse("data: [DONE]\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiResponsesProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIResponses, new GenerationOptions(), extraHeaders: new Dictionary<string, string> { ["Host"] = "evil.example" });
        var exception = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));
        Assert.Equal("invalid_header", exception.Code);
        Assert.Null(handler.Request);
    }

    [Fact]
    public async Task ChatOptionalModernFieldsAreExplicitlyOptedIn()
    {
        var handler = new RecordingHandler(_ => Sse("data: [DONE]\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiChatCompatibleProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions(null, 12), providerOptions: new Dictionary<string, string> { ["use_max_completion_tokens"] = "true", ["include_usage"] = "true" });
        await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken));
        using var json = JsonDocument.Parse(handler.Body!);
        Assert.Equal(12, json.RootElement.GetProperty("max_completion_tokens").GetInt32());
        Assert.False(json.RootElement.TryGetProperty("max_tokens", out _));
        Assert.True(json.RootElement.GetProperty("stream_options").GetProperty("include_usage").GetBoolean());
    }

    [Fact]
    public async Task ChatFinishReasonTerminatesAtEofButTruncatedStreamFails()
    {
        var terminalHandler = new RecordingHandler(_ => Sse(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n" +
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"));
        using var terminalTransport = CustomTransport(terminalHandler);
        var terminalProvider = new OpenAiChatCompatibleProvider(terminalTransport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions());

        var events = await Collect(terminalProvider.StreamAsync(connection, request, TestContext.Current.CancellationToken));

        Assert.Equal("ok", Assert.IsType<ModelStreamEvent.TextDelta>(events[1]).Text);
        Assert.IsType<ModelStreamEvent.Completed>(events[2]);

        var truncatedHandler = new RecordingHandler(_ => Sse("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n"));
        using var truncatedTransport = CustomTransport(truncatedHandler);
        var truncatedProvider = new OpenAiChatCompatibleProvider(truncatedTransport, new FixedCredentials());

        var exception = await Assert.ThrowsAsync<AmiraException>(async () =>
            await Collect(truncatedProvider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));
        Assert.Equal("stream_protocol", exception.Code);
    }

    [Fact]
    public async Task ChatFinishReasonThenUsageThenDoneEmitsTerminalEventsOnce()
    {
        var handler = new RecordingHandler(_ => Sse(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n" +
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n" +
            "data: [DONE]\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiChatCompatibleProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions());

        var events = await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken));

        Assert.Collection(events,
            e => Assert.IsType<ModelStreamEvent.Started>(e),
            e => Assert.Equal("ok", Assert.IsType<ModelStreamEvent.TextDelta>(e).Text),
            e => Assert.Equal((7, 3), Tokens(Assert.IsType<ModelStreamEvent.Usage>(e))),
            e => Assert.IsType<ModelStreamEvent.Completed>(e));
        Assert.Single(events.OfType<ModelStreamEvent.Usage>());
        Assert.Single(events.OfType<ModelStreamEvent.Completed>());
    }

    [Fact]
    public async Task ChatFinishReasonThenDoneCompletesWithoutUsage()
    {
        var handler = new RecordingHandler(_ => Sse(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n" +
            "data: [DONE]\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiChatCompatibleProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions());

        var events = await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken));

        Assert.Collection(events,
            e => Assert.IsType<ModelStreamEvent.Started>(e),
            e => Assert.Equal("ok", Assert.IsType<ModelStreamEvent.TextDelta>(e).Text),
            e => Assert.IsType<ModelStreamEvent.Completed>(e));
        Assert.Empty(events.OfType<ModelStreamEvent.Usage>());
        Assert.Single(events.OfType<ModelStreamEvent.Completed>());
    }

    [Theory]
    [InlineData(
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"late\"}}]}\n\n" +
        "data: [DONE]\n\n")]
    [InlineData(
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n" +
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n" +
        "data: [DONE]\n\n")]
    [InlineData(
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n" +
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
        "data: [DONE]\n\n")]
    public async Task ChatRejectsEventsAfterFinishOrUsageAndDuplicateUsage(string stream)
    {
        var handler = new RecordingHandler(_ => Sse(stream));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiChatCompatibleProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions());

        var exception = await Assert.ThrowsAsync<AmiraException>(async () =>
            await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));

        Assert.Equal("stream_protocol", exception.Code);
    }

    [Fact]
    public async Task Utf8BomBeforeFirstSseFieldIsAccepted()
    {
        var handler = new RecordingHandler(_ => Sse(
            "\uFEFFdata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"bom\"},\"finish_reason\":\"stop\"}]}\n\n",
            fragmented: true));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiChatCompatibleProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions());

        var events = await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken));

        Assert.Equal("bom", Assert.IsType<ModelStreamEvent.TextDelta>(events[1]).Text);
        Assert.IsType<ModelStreamEvent.Completed>(events[2]);
    }

    [Fact]
    public async Task ResponsesMapsRefusalAndStableFailureCodesAndIgnoresUnknownEvent()
    {
        var handler = new RecordingHandler(_ => Sse("event: unknown\ndata: not-json\n\n" + "event: response.refusal.delta\ndata: {\"type\":\"response.refusal.delta\",\"delta\":\"no\"}\n\n" + "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new OpenAiResponsesProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIResponses, new GenerationOptions());
        var events = await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken));
        Assert.Equal("no", Assert.IsType<ModelStreamEvent.TextDelta>(events[1]).Text);
        foreach (var stream in new[] { "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"weird-injected-code\",\"message\":\"bad\"}}}\n\n", "data: {\"type\":\"response.incomplete\"}\n\n", "data: {\"type\":\"error\",\"code\":\"unknown-code\",\"message\":\"bad\"}\n\n" })
        {
            var failureHandler = new RecordingHandler(_ => Sse(stream));
            using var failureTransport = CustomTransport(failureHandler);
            var failureProvider = new OpenAiResponsesProvider(failureTransport, new FixedCredentials());
            var exception = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(failureProvider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));
            Assert.Contains(exception.Code, new[] { "provider_stream_error", "response_incomplete" });
        }
    }

    [Fact]
    public async Task AnthropicMapsErrorTypeToStableCode()
    {
        var handler = new RecordingHandler(_ => Sse("data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}\n\n"));
        using var transport = CustomTransport(handler);
        var provider = new AnthropicMessagesProvider(transport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.AnthropicMessages, new GenerationOptions());
        var exception = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));
        Assert.Equal("provider_overloaded", exception.Code);
        Assert.True(exception.IsTransient);
    }

    [Theory]
    [InlineData(ProviderProtocol.AnthropicMessages)]
    [InlineData(ProviderProtocol.OpenAIChatCompatible)]
    [InlineData(ProviderProtocol.OpenAIResponses)]
    public async Task SecureDefaultTransportRejectsCrossHostRedirectWithoutSecondRequest(ProviderProtocol protocol)
    {
        using var redirectServer = new TcpListener(IPAddress.Loopback, 0);
        using var targetServer = new TcpListener(IPAddress.Loopback, 0);
        redirectServer.Start();
        targetServer.Start();
        int redirectPort = ((IPEndPoint)redirectServer.LocalEndpoint).Port;
        int targetPort = ((IPEndPoint)targetServer.LocalEndpoint).Port;
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task<string> redirectRequest = ServeRedirectAsync(
            redirectServer,
            new Uri($"http://127.0.0.1:{targetPort}/credential-capture"),
            cancellation.Token);
        Task<string> targetRequest = ServeTerminalSseAsync(targetServer, cancellation.Token);
        var (connection, request) = Request(
            protocol,
            new GenerationOptions(),
            new Uri($"http://localhost:{redirectPort}/"));

        try
        {
            AmiraException exception = await Assert.ThrowsAsync<AmiraException>(async () =>
                await InvokeSecureDefaultAsync(protocol, connection, request, TestContext.Current.CancellationToken));

            Assert.Equal("provider_redirect", exception.Code);
            Assert.Equal(ErrorCategory.Provider, exception.Category);
            Assert.Contains("secret-value", await redirectRequest, StringComparison.Ordinal);
            Task completed = await Task.WhenAny(targetRequest, Task.Delay(TimeSpan.FromMilliseconds(500), TestContext.Current.CancellationToken));
            Assert.NotSame(targetRequest, completed);
        }
        finally
        {
            cancellation.Cancel();
        }
    }

    [Fact]
    public async Task InvalidUtf8AndOversizeSseAreProtocolErrors()
    {
        var invalid = new RecordingHandler(_ => Bytes(new byte[] { 0xFF, 0x0A, 0x0A }));
        using var invalidTransport = CustomTransport(invalid);
        var provider = new OpenAiChatCompatibleProvider(invalidTransport, new FixedCredentials());
        var (connection, request) = Request(ProviderProtocol.OpenAIChatCompatible, new GenerationOptions());
        var invalidException = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(provider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));
        Assert.Equal("stream_protocol", invalidException.Code);
        var oversize = new string('x', 1024 * 1024 + 1);
        var oversizedHandler = new RecordingHandler(_ => Sse($"data: {oversize}\n\n"));
        using var oversizedTransport = CustomTransport(oversizedHandler);
        var oversizedProvider = new OpenAiChatCompatibleProvider(oversizedTransport, new FixedCredentials());
        var oversizedException = await Assert.ThrowsAsync<AmiraException>(async () => await Collect(oversizedProvider.StreamAsync(connection, request, TestContext.Current.CancellationToken)));
        Assert.Equal("stream_protocol", oversizedException.Code);
    }

    private static (ProviderConnection Connection, ModelRequest Request) Request(ProviderProtocol protocol, GenerationOptions generationOptions, Uri? baseUrl = null, IReadOnlyDictionary<string, string>? extraHeaders = null, IReadOnlyDictionary<string, string>? providerOptions = null)
    {
        var connection = ProviderConnection.Create(protocol, "test", baseUrl ?? new Uri("https://example.test/api/"), CredentialReference.Create("test-key"), extraHeaders: extraHeaders);
        var profile = ModelProfile.Create(connection.Id, "gpt-test", generationOptions, providerOptions ?? new Dictionary<string, string>());
        return (connection, new ModelRequest(WorkspaceId.New(), BotId.New(), DirectChatId.New(), BotTurnId.New(), profile.Snapshot(protocol),
            [new ModelMessage(ModelMessageRole.User, "hello"), new ModelMessage(ModelMessageRole.Assistant, "prior")], "sys"));
    }

    private static HttpResponseMessage Sse(string text, bool fragmented = false)
    {
        HttpContent content = fragmented ? new FragmentedContent(Encoding.UTF8.GetBytes(text)) : new ByteArrayContent(Encoding.UTF8.GetBytes(text));
        content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
    }

    private static HttpResponseMessage Bytes(byte[] bytes) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };

    private static ProviderTransport CustomTransport(HttpMessageHandler handler) =>
        ProviderTransport.CreateUnsafeCustom(handler);

    private static async Task InvokeSecureDefaultAsync(
        ProviderProtocol protocol,
        ProviderConnection connection,
        ModelRequest request,
        CancellationToken cancellationToken)
    {
        switch (protocol)
        {
            case ProviderProtocol.AnthropicMessages:
                using (var provider = new AnthropicMessagesProvider(new FixedCredentials()))
                    await Collect(provider.StreamAsync(connection, request, cancellationToken));
                break;
            case ProviderProtocol.OpenAIChatCompatible:
                using (var provider = new OpenAiChatCompatibleProvider(new FixedCredentials()))
                    await Collect(provider.StreamAsync(connection, request, cancellationToken));
                break;
            case ProviderProtocol.OpenAIResponses:
                using (var provider = new OpenAiResponsesProvider(new FixedCredentials()))
                    await Collect(provider.StreamAsync(connection, request, cancellationToken));
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(protocol));
        }
    }

    private static async Task<string> ServeRedirectAsync(
        TcpListener listener,
        Uri location,
        CancellationToken cancellationToken)
    {
        using TcpClient client = await listener.AcceptTcpClientAsync(cancellationToken);
        await using NetworkStream stream = client.GetStream();
        string headers = await ReadHeadersAsync(stream, cancellationToken);
        byte[] response = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 302 Found\r\nLocation: {location.AbsoluteUri}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(response, cancellationToken);
        return headers;
    }

    private static async Task<string> ServeTerminalSseAsync(
        TcpListener listener,
        CancellationToken cancellationToken)
    {
        using TcpClient client = await listener.AcceptTcpClientAsync(cancellationToken);
        await using NetworkStream stream = client.GetStream();
        string headers = await ReadHeadersAsync(stream, cancellationToken);
        const string body = "data: [DONE]\n\n";
        byte[] response = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n{body}");
        await stream.WriteAsync(response, cancellationToken);
        return headers;
    }

    private static async Task<string> ReadHeadersAsync(NetworkStream stream, CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(stream, Encoding.ASCII, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        var headers = new StringBuilder();
        while (await reader.ReadLineAsync(cancellationToken) is { Length: > 0 } line)
            headers.AppendLine(line);
        return headers.ToString();
    }

    private static async Task<List<ModelStreamEvent>> Collect(IAsyncEnumerable<ModelStreamEvent> source)
    {
        var events = new List<ModelStreamEvent>();
        await foreach (var item in source) events.Add(item);
        return events;
    }

    private static (int? Input, int? Output) Tokens(ModelStreamEvent.Usage usage) => (usage.Value.InputTokens, usage.Value.OutputTokens);

    private sealed class FixedCredentials : ICredentialResolver
    {
        public ValueTask<string?> ResolveAsync(CredentialReference reference, CancellationToken cancellationToken = default) => new("secret-value");
    }

    private sealed class MissingCredentials : ICredentialResolver
    {
        public ValueTask<string?> ResolveAsync(CredentialReference reference, CancellationToken cancellationToken = default) => new((string?)null);
    }

    private sealed class RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) : HttpMessageHandler
    {
        public HttpRequestMessage? Request { get; private set; }
        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Request = request;
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return responder(request);
        }
    }

    private sealed class FragmentedContent(byte[] bytes) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => stream.WriteAsync(bytes).AsTask();
        protected override bool TryComputeLength(out long length) { length = bytes.Length; return true; }
        protected override Task<Stream> CreateContentReadStreamAsync() => Task.FromResult<Stream>(new FragmentedStream(bytes));
    }

    private sealed class FragmentedStream(byte[] bytes) : Stream
    {
        private int offset;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => bytes.Length;
        public override long Position { get => offset; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer)
        {
            if (offset == bytes.Length) return 0;
            int count = Math.Min(Math.Min(buffer.Length, 3), bytes.Length - offset);
            bytes.AsSpan(offset, count).CopyTo(buffer);
            offset += count;
            return count;
        }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) { cancellationToken.ThrowIfCancellationRequested(); return new(Read(buffer.Span)); }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => Task.FromResult(Read(buffer, offset, count));
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
