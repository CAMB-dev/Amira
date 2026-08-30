using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Amira.Observability;
using Amira.Persistence.Sqlite;
using Amira.Providers;
using Amira.Runtime;
using Microsoft.Extensions.Logging;

return await AotSmoke.RunAsync().ConfigureAwait(false);

internal static partial class AotSmoke
{
    private const string AotLogPromptCanary = "AOT_LOG_PROMPT_CANARY_793D1A";
    private const string AotLogSafeMarker = "AOT_LOG_SAFE_MARKER";
    private const string ParentActivitySourceName = "Amira.Core.AotSmoke.Parent";
    private const string PrimaryPrompt = "Core AOT prompt.";
    private const string PrimaryReply = "Core AOT reply.";
    private const string RetryPrompt = "Core AOT retry prompt.";
    private const string RetryReply = "Core AOT retry reply.";

    public static async Task<int> RunAsync()
    {
        try
        {
            Ensure(!JsonSerializer.IsReflectionEnabledByDefault, "JSON reflection must remain disabled.");
            VerifyObservability();
            await VerifyCoreAsync().ConfigureAwait(false);
            await VerifyProviderAdaptersAsync().ConfigureAwait(false);
            Console.WriteLine("AMIRA_CORE_AOT_SMOKE_SAFE");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"AMIRA_CORE_AOT_SMOKE_FAILED:{exception.GetType().Name}");
            return 1;
        }
    }

    private static void VerifyObservability()
    {
        string directoryPath = Path.Combine(Path.GetTempPath(), $"amira-aot-observability-{Guid.NewGuid():N}");
        try
        {
            using (ILoggerFactory factory = AmiraLogging.CreateJsonFileLoggerFactory(new JsonFileLoggingOptions
            {
                DirectoryPath = directoryPath,
                BlockWhenFull = true,
            }))
            {
                WriteAotLog(factory.CreateLogger("Amira.Core.AotSmoke"), AotLogSafeMarker, AotLogPromptCanary);
            }

            string filePath = Directory.GetFiles(directoryPath, "*.jsonl", SearchOption.TopDirectoryOnly).Single();
            string json = File.ReadAllText(filePath);
            Ensure(json.Contains(AotLogSafeMarker, StringComparison.Ordinal), "The safe AOT log marker was not written.");
            Ensure(!json.Contains(AotLogPromptCanary, StringComparison.Ordinal), "The AOT log leaked prompt content.");
            using JsonDocument document = JsonDocument.Parse(json);
            Ensure(document.RootElement.GetProperty("event_id").GetInt32() == 9101, "The AOT log event ID changed.");
        }
        finally
        {
            if (Directory.Exists(directoryPath))
            {
                Directory.Delete(directoryPath, recursive: true);
            }
        }
    }

    [LoggerMessage(
        EventId = 9101,
        EventName = "aot.observability.safe",
        Level = LogLevel.Information,
        Message = "AOT log {SafeMarker} {Prompt}")]
    private static partial void WriteAotLog(ILogger logger, string safeMarker, string prompt);

    private static async Task VerifyCoreAsync()
    {
        string databasePath = Path.Combine(Path.GetTempPath(), $"amira-core-aot-{Guid.NewGuid():N}.db");
        try
        {
            WorkspaceId workspaceId = WorkspaceId.New();
            ProviderConnection connection = ProviderConnection.Create(
                ProviderProtocol.OpenAIChatCompatible,
                "AOT smoke connection",
                new Uri("https://provider.invalid/v1/"),
                CredentialReference.Create("aot-smoke-credential"),
                "smoke-model");
            ModelProfile modelProfile = ModelProfile.Create(
                connection.Id,
                "smoke-model",
                new GenerationOptions(0.25, 128));
            var provider = new ScriptedRuntimeProvider();
            var registry = new ProviderRegistry([provider]);
            registry.Freeze();

            Bot bot;
            QueuedMessageResult primaryQueued;
            QueuedMessageResult retrySeed;
            BotTurn retry;
            ActivityContext expectedParent;
            using (var store = new SqliteAmiraStore(databasePath))
            {
                await store.InitializeAsync().ConfigureAwait(false);
                await store.SaveProviderConnectionAsync(connection).ConfigureAwait(false);
                bot = await store.CreateBotAsync(new CreateBotCommand(
                    BotProfile.Create("AOT smoke bot", instructions: "Reply concisely."),
                    modelProfile)).ConfigureAwait(false);
                var runtime = new BasicChatRuntime(store, store, registry);

                using var listener = new ActivityListener
                {
                    ShouldListenTo = static source => source.Name == ParentActivitySourceName,
                    Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
                    SampleUsingParentId = static (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.AllDataAndRecorded,
                };
                ActivitySource.AddActivityListener(listener);
                using var parentSource = new ActivitySource(ParentActivitySourceName);
                using Activity parent = parentSource.StartActivity("incoming", ActivityKind.Server)
                    ?? throw new InvalidOperationException("The sampled parent Activity was not created.");
                expectedParent = parent.Context;
                Ensure(expectedParent.TraceFlags.HasFlag(ActivityTraceFlags.Recorded), "The parent Activity was not sampled.");
                primaryQueued = await runtime.QueueHumanMessageAsync(
                    workspaceId,
                    bot.Id,
                    PrimaryPrompt).ConfigureAwait(false);
            }

            using (var store = new SqliteAmiraStore(databasePath))
            {
                await store.InitializeAsync().ConfigureAwait(false);
                var runtime = new BasicChatRuntime(store, store, registry);
                ClaimedTurn primaryClaim = await store.TryClaimNextTurnAsync(bot.Id).ConfigureAwait(false)
                    ?? throw new InvalidOperationException("The persisted turn was not claimable after reopen.");
                Ensure(primaryClaim.Turn.Id == primaryQueued.Turn.Id, "The wrong turn was claimed after reopen.");
                EnsureSameActivityContext(expectedParent, primaryClaim.ParentActivityContext);

                List<ChatRuntimeEvent> primaryEvents = await CollectAsync(
                    runtime.ExecuteClaimedAsync(workspaceId, primaryClaim)).ConfigureAwait(false);
                EnsureRuntimeSuccess(primaryEvents, PrimaryReply, 5, 3);

                retrySeed = await runtime.QueueHumanMessageAsync(
                    workspaceId,
                    bot.Id,
                    RetryPrompt).ConfigureAwait(false);
                List<ChatRuntimeEvent> failureEvents = await CollectAsync(
                    runtime.ExecuteNextAsync(workspaceId, bot.Id)).ConfigureAwait(false);
                Ensure(failureEvents is [ChatRuntimeEvent.Started, ChatRuntimeEvent.Failed { Failure.Code: AmiraErrorCodes.ProviderStreamError }],
                    "The scripted provider failure was not durably observed.");

                retry = await runtime.RetryAsync(retrySeed.Turn.Id).ConfigureAwait(false);
                Ensure(retry.Attempt == 2 && retry.RetryOfTurnId == retrySeed.Turn.Id, "Retry lineage was not preserved.");
                ClaimedTurn retryClaim = await store.TryClaimNextTurnAsync(bot.Id).ConfigureAwait(false)
                    ?? throw new InvalidOperationException("The retry was not claimable.");
                Ensure(retryClaim.Turn.Id == retry.Id, "The retry claim returned the wrong turn.");
                List<ChatRuntimeEvent> retryEvents = await CollectAsync(
                    runtime.ExecuteClaimedAsync(workspaceId, retryClaim)).ConfigureAwait(false);
                EnsureRuntimeSuccess(retryEvents, RetryReply, 7, 4);
            }

            using (var store = new SqliteAmiraStore(databasePath))
            {
                await store.InitializeAsync().ConfigureAwait(false);
                Bot reloadedBot = await store.GetBotAsync(bot.Id).ConfigureAwait(false)
                    ?? throw new InvalidOperationException("The Bot was not persisted.");
                ProviderConnection reloadedConnection = await store.GetProviderConnectionAsync(connection.Id).ConfigureAwait(false)
                    ?? throw new InvalidOperationException("The provider connection was not persisted.");
                Ensure(reloadedBot.DirectChatId == bot.DirectChatId, "The Bot direct chat changed after reopen.");
                Ensure(reloadedConnection.Protocol == connection.Protocol, "The provider connection changed after reopen.");

                IReadOnlyList<ChatMessage> timeline = await store.LoadTimelineAsync(bot.DirectChatId).ConfigureAwait(false);
                Ensure(timeline.Count == 4, "The final timeline contains an unexpected number of messages.");
                EnsureMessage(timeline[0], MessageAuthor.Human, PrimaryPrompt);
                EnsureMessage(timeline[1], MessageAuthor.Bot, PrimaryReply);
                EnsureMessage(timeline[2], MessageAuthor.Human, RetryPrompt);
                EnsureMessage(timeline[3], MessageAuthor.Bot, RetryReply);

                TurnView primaryView = await store.GetTurnAsync(primaryQueued.Turn.Id).ConfigureAwait(false)
                    ?? throw new InvalidOperationException("The completed primary turn was not queryable.");
                Ensure(primaryView.Status == BotTurnStatus.Completed, "The primary turn query status changed.");
                Ensure(primaryView.Usage is { InputTokens: 5, OutputTokens: 3 }, "The primary turn query usage changed.");

                TurnView failedView = await store.GetTurnAsync(retrySeed.Turn.Id).ConfigureAwait(false)
                    ?? throw new InvalidOperationException("The failed turn was not queryable.");
                Ensure(failedView.Status == BotTurnStatus.Failed, "The failed turn query status changed.");
                Ensure(failedView.Failure is { Code: AmiraErrorCodes.ProviderStreamError }, "The failed turn query error changed.");

                TurnView retryView = await store.GetTurnAsync(retry.Id).ConfigureAwait(false)
                    ?? throw new InvalidOperationException("The completed retry was not queryable.");
                Ensure(retryView.RetryOfTurnId == retrySeed.Turn.Id && retryView.Attempt == 2,
                    "The turn query retry lineage changed.");
                Ensure(retryView.Usage is { InputTokens: 7, OutputTokens: 4 }, "The retry turn query usage changed.");

                TurnPage firstPage = await store.QueryTurnsAsync(new TurnQuery(botId: bot.Id, pageSize: 2)).ConfigureAwait(false);
                Ensure(firstPage.Items.Count == 2 && firstPage.NextCursor is not null,
                    "The first turn query page shape changed.");
                TurnPage finalPage = await store.QueryTurnsAsync(new TurnQuery(
                    botId: bot.Id,
                    pageSize: 2,
                    before: firstPage.NextCursor)).ConfigureAwait(false);
                Ensure(finalPage.Items.Count == 1 && finalPage.NextCursor is null,
                    "The final turn query page shape changed.");
                BotTurnId[] queriedTurnIds = [.. firstPage.Items.Select(item => item.TurnId), .. finalPage.Items.Select(item => item.TurnId)];
                Ensure(queriedTurnIds.Distinct().Count() == 3, "Turn keyset paging duplicated or skipped a turn.");
                string safeTurns = string.Join('|', firstPage.Items.Concat(finalPage.Items));
                Ensure(!safeTurns.Contains(PrimaryPrompt, StringComparison.Ordinal)
                    && !safeTurns.Contains(RetryPrompt, StringComparison.Ordinal),
                    "The safe turn projection exposed message content.");
            }
        }
        finally
        {
            foreach (string suffix in new[] { string.Empty, "-wal", "-shm" })
            {
                File.Delete(databasePath + suffix);
            }
        }
    }

    private static async Task VerifyProviderAdaptersAsync()
    {
        await VerifyChatAdapterAsync().ConfigureAwait(false);
        await VerifyResponsesAdapterAsync().ConfigureAwait(false);
        await VerifyAnthropicAdapterAsync().ConfigureAwait(false);
    }

    private static async Task VerifyChatAdapterAsync()
    {
        const string stream = """
            data: {"choices":[{"index":0,"delta":{"content":"chat-adapter"}}]}

            data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}

            data: [DONE]

            """;
        using var handler = new SseHandler(stream);
        using var transport = ProviderTransport.CreateUnsafeCustom(handler);
        using var provider = new OpenAiChatCompatibleProvider(transport, new FixedCredentialResolver());
        (ProviderConnection connection, ModelRequest request) = CreateAdapterRequest(
            ProviderProtocol.OpenAIChatCompatible,
            new Dictionary<string, string> { ["include_usage"] = "true" });

        List<ModelStreamEvent> events = await CollectAsync(provider.StreamAsync(connection, request)).ConfigureAwait(false);

        EnsureProviderSuccess(events, "chat-adapter", 3, 2);
        Ensure(handler.RequestPath == "/api/chat/completions", "The Chat adapter used the wrong endpoint.");
        Ensure(handler.AuthorizationScheme == "Bearer" && handler.CredentialHeaderSeen, "The Chat adapter did not apply credentials.");
        using JsonDocument body = JsonDocument.Parse(handler.RequestBody!);
        Ensure(body.RootElement.GetProperty("model").GetString() == "adapter-model", "The Chat request model was not serialized.");
        Ensure(body.RootElement.GetProperty("stream_options").GetProperty("include_usage").GetBoolean(), "The Chat usage request was not serialized.");
    }

    private static async Task VerifyResponsesAdapterAsync()
    {
        const string stream = """
            event: response.output_text.delta
            data: {"type":"response.output_text.delta","delta":"responses-adapter"}

            event: response.completed
            data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":4}}}

            """;
        using var handler = new SseHandler(stream);
        using var transport = ProviderTransport.CreateUnsafeCustom(handler);
        using var provider = new OpenAiResponsesProvider(transport, new FixedCredentialResolver());
        (ProviderConnection connection, ModelRequest request) = CreateAdapterRequest(ProviderProtocol.OpenAIResponses);

        List<ModelStreamEvent> events = await CollectAsync(provider.StreamAsync(connection, request)).ConfigureAwait(false);

        EnsureProviderSuccess(events, "responses-adapter", 5, 4);
        Ensure(handler.RequestPath == "/api/responses", "The Responses adapter used the wrong endpoint.");
        Ensure(handler.AuthorizationScheme == "Bearer" && handler.CredentialHeaderSeen, "The Responses adapter did not apply credentials.");
        using JsonDocument body = JsonDocument.Parse(handler.RequestBody!);
        Ensure(!body.RootElement.GetProperty("store").GetBoolean(), "The Responses adapter enabled remote storage.");
        Ensure(body.RootElement.GetProperty("input")[0].GetProperty("content")[0].GetProperty("text").GetString() == "adapter prompt",
            "The Responses input projection was not serialized.");
    }

    private static async Task VerifyAnthropicAdapterAsync()
    {
        const string stream = """
            data: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_creation_input_tokens":1,"cache_read_input_tokens":2}}}

            data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"anthropic-adapter"}}

            data: {"type":"message_delta","usage":{"output_tokens":6}}

            data: {"type":"message_stop"}

            """;
        using var handler = new SseHandler(stream);
        using var transport = ProviderTransport.CreateUnsafeCustom(handler);
        using var provider = new AnthropicMessagesProvider(transport, new FixedCredentialResolver());
        (ProviderConnection connection, ModelRequest request) = CreateAdapterRequest(ProviderProtocol.AnthropicMessages);

        List<ModelStreamEvent> events = await CollectAsync(provider.StreamAsync(connection, request)).ConfigureAwait(false);

        EnsureProviderSuccess(events, "anthropic-adapter", 10, 6);
        Ensure(handler.RequestPath == "/api/v1/messages", "The Anthropic adapter used the wrong endpoint.");
        Ensure(handler.AuthorizationScheme is null && handler.CredentialHeaderSeen, "The Anthropic adapter did not apply credentials.");
        using JsonDocument body = JsonDocument.Parse(handler.RequestBody!);
        Ensure(body.RootElement.GetProperty("system").GetString() == "adapter system", "The Anthropic system instruction was not serialized.");
        Ensure(body.RootElement.GetProperty("max_tokens").GetInt32() == 64, "The Anthropic token limit was not serialized.");
    }

    private static (ProviderConnection Connection, ModelRequest Request) CreateAdapterRequest(
        ProviderProtocol protocol,
        IReadOnlyDictionary<string, string>? providerOptions = null)
    {
        ProviderConnection connection = ProviderConnection.Create(
            protocol,
            "Adapter smoke connection",
            new Uri("https://provider.invalid/api/"),
            CredentialReference.Create("adapter-smoke-credential"),
            "adapter-model");
        ModelProfile profile = ModelProfile.Create(
            connection.Id,
            "adapter-model",
            new GenerationOptions(0.5, 64),
            providerOptions);
        var request = new ModelRequest(
            WorkspaceId.New(),
            BotId.New(),
            DirectChatId.New(),
            BotTurnId.New(),
            profile.Snapshot(protocol),
            [new ModelMessage(ModelMessageRole.User, "adapter prompt"), new ModelMessage(ModelMessageRole.Assistant, "adapter history")],
            "adapter system");
        return (connection, request);
    }

    private static void EnsureRuntimeSuccess(
        IReadOnlyList<ChatRuntimeEvent> events,
        string expectedText,
        int expectedInputTokens,
        int expectedOutputTokens)
    {
        if (events is not
        [
            ChatRuntimeEvent.Started,
            ChatRuntimeEvent.TextDelta textDelta,
            ChatRuntimeEvent.UsageReported usageEvent,
            ChatRuntimeEvent.Completed completedEvent
        ])
        {
            throw new InvalidOperationException("The runtime stream shape was unexpected.");
        }

        Ensure(textDelta.Text == expectedText && completedEvent.Text == expectedText, "The runtime response content changed.");
        Ensure(usageEvent.Value.InputTokens == expectedInputTokens && usageEvent.Value.OutputTokens == expectedOutputTokens,
            "The runtime usage changed.");
    }

    private static void EnsureProviderSuccess(
        IReadOnlyList<ModelStreamEvent> events,
        string expectedText,
        int expectedInputTokens,
        int expectedOutputTokens)
    {
        if (events is not
        [
            ModelStreamEvent.Started,
            ModelStreamEvent.TextDelta textDelta,
            ModelStreamEvent.Usage usageEvent,
            ModelStreamEvent.Completed
        ])
        {
            throw new InvalidOperationException("The provider stream shape was unexpected.");
        }

        Ensure(textDelta.Text == expectedText, "The provider response content changed.");
        Ensure(usageEvent.Value.InputTokens == expectedInputTokens && usageEvent.Value.OutputTokens == expectedOutputTokens,
            "The provider usage changed.");
    }

    private static void EnsureSameActivityContext(ActivityContext expected, ActivityContext actual)
    {
        Ensure(actual.TraceId == expected.TraceId, "The persisted trace ID changed.");
        Ensure(actual.SpanId == expected.SpanId, "The persisted span ID changed.");
        Ensure(actual.TraceFlags == expected.TraceFlags, "The persisted trace flags changed.");
        Ensure(actual.TraceState == expected.TraceState, "The persisted trace state changed.");
        Ensure(actual.IsRemote == expected.IsRemote, "The persisted remote flag changed.");
    }

    private static void EnsureMessage(ChatMessage message, MessageAuthor author, string content)
    {
        Ensure(message.Author == author && message.Revision.Content == content, "The persisted timeline content changed.");
    }

    private static async Task<List<T>> CollectAsync<T>(IAsyncEnumerable<T> source)
    {
        var events = new List<T>();
        await foreach (T item in source.ConfigureAwait(false))
        {
            events.Add(item);
        }

        return events;
    }

    private static void Ensure(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private sealed class ScriptedRuntimeProvider : IModelProvider
    {
        private int _calls;

        public ProviderProtocol Protocol => ProviderProtocol.OpenAIChatCompatible;

        public async IAsyncEnumerable<ModelStreamEvent> StreamAsync(
            ProviderConnection connection,
            ModelRequest request,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            request.ValidateConnection(connection);
            await Task.Yield();
            cancellationToken.ThrowIfCancellationRequested();
            int call = Interlocked.Increment(ref _calls);
            yield return new ModelStreamEvent.Started();
            if (call == 2)
            {
                throw new AmiraException(new AmiraError(
                    AmiraErrorCodes.ProviderStreamError,
                    ErrorCategory.Provider,
                    "The scripted provider request failed."));
            }

            string response = call switch
            {
                1 => PrimaryReply,
                3 => RetryReply,
                _ => throw new InvalidOperationException("The runtime provider received an unexpected request."),
            };
            yield return new ModelStreamEvent.TextDelta(response);
            yield return call == 1
                ? new ModelStreamEvent.Usage(new ProviderUsage(5, 3))
                : new ModelStreamEvent.Usage(new ProviderUsage(7, 4));
            yield return new ModelStreamEvent.Completed();
        }
    }

    private sealed class FixedCredentialResolver : ICredentialResolver
    {
        public ValueTask<string?> ResolveAsync(
            CredentialReference reference,
            CancellationToken cancellationToken = default) => new("fixture-token");
    }

    private sealed class SseHandler(string stream) : HttpMessageHandler
    {
        public string? RequestPath { get; private set; }
        public string? RequestBody { get; private set; }
        public string? AuthorizationScheme { get; private set; }
        public bool CredentialHeaderSeen { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestPath = request.RequestUri?.AbsolutePath;
            RequestBody = request.Content is null
                ? null
                : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            AuthorizationScheme = request.Headers.Authorization?.Scheme;
            CredentialHeaderSeen = request.Headers.Authorization?.Parameter == "fixture-token"
                || request.Headers.TryGetValues("x-api-key", out IEnumerable<string>? values) && values.Contains("fixture-token", StringComparer.Ordinal);
            var content = new ByteArrayContent(Encoding.UTF8.GetBytes(stream));
            content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
        }
    }
}
