#pragma warning disable xUnit1051
using System.Diagnostics;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Amira.Persistence.Sqlite;
using Microsoft.Data.Sqlite;

namespace Amira.Persistence.Sqlite.Tests;

public sealed class SqliteStoreTests
{
    [Fact]
    public async Task Empty_database_initialization_is_concurrent_idempotent_and_uses_wal()
    {
        await using var database = TestDatabase.Create();

        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => database.Store.InitializeAsync().AsTask()));
        await database.Store.InitializeAsync();

        Assert.Equal(5L, await database.ScalarAsync<long>("SELECT MAX(version) FROM schema_migrations;"));
        Assert.Equal(5L, await database.ScalarAsync<long>("SELECT COUNT(*) FROM schema_migrations;"));
        Assert.Equal(5L, await database.ScalarAsync<long>("PRAGMA user_version;"));
        Assert.Equal("wal", await database.ScalarAsync<string>("PRAGMA journal_mode;"));
        var messagesSql = await database.ScalarAsync<string>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages';");
        Assert.Contains("DEFERRABLE INITIALLY DEFERRED", messagesSql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Empty_database_initialization_is_serialized_across_store_instances()
    {
        await using var database = TestDatabase.Create();
        using var second = new SqliteAmiraStore(database.Path);

        await Task.WhenAll(database.Store.InitializeAsync().AsTask(), second.InitializeAsync().AsTask());

        Assert.Equal(["1", "2", "3", "4", "5"], await database.QueryStringsAsync("SELECT version FROM schema_migrations ORDER BY version;"));
    }

    [Fact]
    public async Task Version_one_database_is_upgraded_to_latest_idempotently()
    {
        await using var database = TestDatabase.Create();
        await database.Store.InitializeAsync();
        var seeded = await SeedBotAsync(database, "migration-v1");
        QueuedMessageResult queued = await QueueAsync(database, seeded, "preserve me");
        database.DisposeStore();

        await database.ExecuteAsync("ALTER TABLE bot_turns DROP COLUMN input_tokens;");
        await database.ExecuteAsync("ALTER TABLE bot_turns DROP COLUMN output_tokens;");
        await database.ExecuteAsync("ALTER TABLE bot_turns DROP COLUMN failure_category;");
        await database.ExecuteAsync("ALTER TABLE bot_turns DROP COLUMN parent_trace_id;");
        await database.ExecuteAsync("ALTER TABLE bot_turns DROP COLUMN parent_span_id;");
        await database.ExecuteAsync("ALTER TABLE bot_turns DROP COLUMN parent_trace_flags;");
        await database.ExecuteAsync("ALTER TABLE bot_turns DROP COLUMN parent_trace_state;");
        await database.ExecuteAsync("ALTER TABLE bot_turns DROP COLUMN parent_is_remote;");
        await database.ExecuteAsync("ALTER TABLE bot_turns DROP COLUMN first_token_at;");
        await database.ExecuteAsync("DELETE FROM schema_migrations WHERE version >= 2;");
        await database.ExecuteAsync("PRAGMA user_version=1;");

        database.ReopenStore();
        await database.Store.InitializeAsync();
        await database.Store.InitializeAsync();

        var columns = await database.QueryStringsAsync("SELECT name FROM pragma_table_info('bot_turns');");
        Assert.Contains("input_tokens", columns);
        Assert.Contains("output_tokens", columns);
        Assert.Contains("failure_category", columns);
        Assert.Contains("parent_trace_id", columns);
        Assert.Contains("parent_span_id", columns);
        Assert.Contains("first_token_at", columns);
        Assert.Equal(5L, await database.ScalarAsync<long>("SELECT MAX(version) FROM schema_migrations;"));
        Assert.Equal(5L, await database.ScalarAsync<long>("PRAGMA user_version;"));
        ClaimedTurn claimed = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));
        Assert.Equal(queued.Turn.Id, claimed.Turn.Id);
        Assert.Null(claimed.Turn.FirstTokenAt);
    }

    [Fact]
    public async Task Provider_connection_save_get_list_and_header_replacement_round_trip()
    {
        await using var database = TestDatabase.Create();
        var connection = ProviderConnection.Create(
            ProviderProtocol.OpenAIResponses,
            "Local responses",
            new Uri("http://localhost:4321/v1/"),
            CredentialReference.Create("credential-ref"),
            "model-a",
            new Dictionary<string, string> { ["X-Region"] = "sg", ["X-Trace"] = "on" },
            enabled: false);

        await database.Store.SaveProviderConnectionAsync(connection);
        var loaded = await database.Store.GetProviderConnectionAsync(connection.Id);

        Assert.NotNull(loaded);
        Assert.Equal(connection.Protocol, loaded!.Protocol);
        Assert.Equal(connection.DisplayName, loaded.DisplayName);
        Assert.Equal(connection.BaseUrl, loaded.BaseUrl);
        Assert.Equal(connection.CredentialReference, loaded.CredentialReference);
        Assert.Equal(connection.DefaultModel, loaded.DefaultModel);
        Assert.False(loaded.Enabled);
        Assert.Equal("sg", loaded.ExtraHeaders["X-Region"]);
        Assert.Equal("on", loaded.ExtraHeaders["X-Trace"]);

        var replacement = ProviderConnection.Rehydrate(
            connection.Id,
            ProviderProtocol.AnthropicMessages,
            "Updated",
            new Uri("https://models.example.test/api/"),
            CredentialReference.Create("new-ref"),
            null,
            new Dictionary<string, string> { ["X-New"] = "yes" },
            enabled: true);
        await database.Store.SaveProviderConnectionAsync(replacement);

        var listed = Assert.Single(await database.Store.ListProviderConnectionsAsync());
        Assert.Equal(ProviderProtocol.AnthropicMessages, listed.Protocol);
        Assert.True(listed.Enabled);
        Assert.Null(listed.DefaultModel);
        Assert.Single(listed.ExtraHeaders);
        Assert.Equal("yes", listed.ExtraHeaders["X-New"]);
    }

    [Fact]
    public async Task Bot_full_update_options_archive_restore_get_and_list_round_trip()
    {
        await using var database = TestDatabase.Create();
        var first = await SaveConnectionAsync(database, "first");
        var second = await SaveConnectionAsync(database, "second", ProviderProtocol.AnthropicMessages);
        var originalModel = ModelProfile.Create(first.Id, "model-a");
        var bot = await database.Store.CreateBotAsync(
            new CreateBotCommand(BotProfile.Create("Amira", "old", "old instructions"), originalModel));

        var updated = bot
            .RenameOrEditProfile("Amira updated", "new description", "new instructions")
            .EditModelSettings(
            second.Id,
            "model-b",
            new GenerationOptions(1.25, 777),
            new Dictionary<string, string> { ["thinking"] = "high", ["region"] = "sg" });
        await database.Store.UpdateBotAsync(updated);

        var loaded = await database.Store.GetBotAsync(bot.Id);
        Assert.NotNull(loaded);
        Assert.Equal("Amira updated", loaded!.Profile.Name);
        Assert.Equal("new description", loaded.Profile.Description);
        Assert.Equal("new instructions", loaded.Profile.Instructions);
        Assert.Equal(second.Id, loaded.ModelProfile.ConnectionId);
        Assert.Equal("model-b", loaded.ModelProfile.Model);
        Assert.Equal(1.25, loaded.ModelProfile.GenerationOptions.Temperature);
        Assert.Equal(777, loaded.ModelProfile.GenerationOptions.MaxOutputTokens);
        Assert.Equal("high", loaded.ModelProfile.ProviderOptions["thinking"]);
        Assert.Equal("sg", loaded.ModelProfile.ProviderOptions["region"]);
        Assert.Equal(bot.DirectChatId, loaded.DirectChatId);
        Assert.Equal(bot.Id, Assert.Single(await database.Store.ListBotsAsync()).Id);

        Assert.Equal(BotLifecycleState.Archived, (await database.Store.ArchiveBotAsync(bot.Id)).LifecycleState);
        Assert.Equal(BotLifecycleState.Active, (await database.Store.RestoreBotAsync(bot.Id)).LifecycleState);
    }

    [Fact]
    public async Task Bot_update_identity_mismatch_rolls_back_profile_change()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "rollback");
        Bot renamed = seeded.Bot.RenameOrEditProfile("must roll back");
        Bot invalid = Bot.Rehydrate(
            renamed.Id,
            renamed.Profile,
            ModelProfile.Create(seeded.Connection.Id, "replacement-id"),
            renamed.DirectChatId,
            renamed.CreatedAt,
            renamed.LifecycleState);

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() => database.Store.UpdateBotAsync(invalid).AsTask());
        Assert.Equal("model_profile_identity_mismatch", exception.Code);

        var loaded = await database.Store.GetBotAsync(seeded.Bot.Id);
        Assert.NotNull(loaded);
        Assert.Equal("rollback", loaded!.Profile.Name);
        Assert.Equal(seeded.Bot.ModelProfile.Id, loaded.ModelProfile.Id);
    }

    [Fact]
    public async Task Bot_and_direct_chat_creation_rolls_back_when_provider_foreign_key_is_missing()
    {
        await using var database = TestDatabase.Create();
        var missingConnection = ProviderConnectionId.New();

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.CreateBotAsync(
                new CreateBotCommand(
                    BotProfile.Create("orphan"),
                    ModelProfile.Create(missingConnection, "model"))).AsTask());
        Assert.Equal(ErrorCategory.Persistence, exception.Category);

        Assert.Equal(0L, await database.ScalarAsync<long>("SELECT COUNT(*) FROM bots;"));
        Assert.Equal(0L, await database.ScalarAsync<long>("SELECT COUNT(*) FROM chats;"));
    }

    [Fact]
    public async Task Human_message_turn_snapshot_triggers_and_exact_content_round_trip()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "snapshot");
        Bot configured = seeded.Bot.EditModelSettings(
            seeded.Connection.Id,
            "snap-model",
            new GenerationOptions(0.75, 321),
            new Dictionary<string, string> { ["mode"] = "precise" });
        await database.Store.UpdateBotAsync(configured);
        var snapshot = configured.ModelProfile.Snapshot(seeded.Connection.Protocol);
        const string content = "  first line\r\nsecond line\nemoji: 🦊  ";

        var queued = await database.Store.CommitHumanMessageAndQueueTurnAsync(
            new HumanMessageCommand(seeded.Bot.DirectChatId, content, seeded.Bot.Id, snapshot));
        var timeline = await database.Store.LoadTimelineAsync(seeded.Bot.DirectChatId);
        var claim = await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id);

        Assert.Equal(content, Assert.Single(timeline).Revision.Content);
        Assert.NotNull(claim);
        Assert.Equal(queued.Message.Id, Assert.Single(claim!.Turn.TriggerMessageIds));
        Assert.Equal("snap-model", claim.Turn.ModelProfileSnapshot.Model);
        Assert.Equal(0.75, claim.Turn.ModelProfileSnapshot.GenerationOptions.Temperature);
        Assert.Equal(321, claim.Turn.ModelProfileSnapshot.GenerationOptions.MaxOutputTokens);
        Assert.Equal("precise", claim.Turn.ModelProfileSnapshot.ProviderOptions["mode"]);
    }

    [Fact]
    public async Task Trace_parent_round_trips_across_reopen_and_is_preserved_by_retry()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "trace-parent");
        var parent = new ActivityContext(
            ActivityTraceId.CreateFromString("0123456789abcdef0123456789abcdef".AsSpan()),
            ActivitySpanId.CreateFromString("0123456789abcdef".AsSpan()),
            ActivityTraceFlags.Recorded,
            "vendor=value",
            isRemote: true);
        QueuedMessageResult queued = await database.Store.CommitHumanMessageAndQueueTurnAsync(new HumanMessageCommand(
            seeded.Bot.DirectChatId,
            "trace me",
            seeded.Bot.Id,
            seeded.Bot.ModelProfile.Snapshot(seeded.Connection.Protocol),
            parent));

        database.DisposeStore();
        database.ReopenStore();
        ClaimedTurn firstClaim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));
        Assert.Equal(queued.Turn.Id, firstClaim.Turn.Id);
        Assert.Equal(parent, firstClaim.ParentActivityContext);
        await database.Store.FailTurnAsync(
            firstClaim.Turn.Id,
            firstClaim.ClaimToken,
            new AmiraError("retryable", ErrorCategory.Provider, "retry", true));
        BotTurn retry = await database.Store.RetryTurnAsync(firstClaim.Turn.Id);

        database.DisposeStore();
        database.ReopenStore();
        ClaimedTurn retryClaim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));
        Assert.Equal(retry.Id, retryClaim.Turn.Id);
        Assert.Equal(parent, retryClaim.ParentActivityContext);
    }

    [Fact]
    public async Task Chat_and_bot_mismatch_commits_neither_message_nor_turn()
    {
        await using var database = TestDatabase.Create();
        var first = await SeedBotAsync(database, "first-bot");
        var second = await SeedBotAsync(database, "second-bot");

        AmiraException mismatch = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.CommitHumanMessageAndQueueTurnAsync(
                new HumanMessageCommand(
                    first.Bot.DirectChatId,
                    "not allowed",
                    second.Bot.Id,
                    second.Bot.ModelProfile.Snapshot(second.Connection.Protocol))).AsTask());
        Assert.Equal("chat_bot_mismatch", mismatch.Code);

        Assert.Empty(await database.Store.LoadTimelineAsync(first.Bot.DirectChatId));
        Assert.Null(await database.Store.TryClaimNextTurnAsync(second.Bot.Id));
    }

    [Fact]
    public async Task Snapshot_from_another_bot_commits_neither_message_nor_turn()
    {
        await using var database = TestDatabase.Create();
        var first = await SeedBotAsync(database, "snapshot-first");
        var second = await SeedBotAsync(database, "snapshot-second");

        AmiraException mismatch = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.CommitHumanMessageAndQueueTurnAsync(
                new HumanMessageCommand(
                    first.Bot.DirectChatId,
                    "wrong snapshot",
                    first.Bot.Id,
                    second.Bot.ModelProfile.Snapshot(second.Connection.Protocol))).AsTask());

        Assert.Equal(AmiraErrorCodes.SnapshotMismatch, mismatch.Code);
        Assert.Equal(ErrorCategory.DomainRule, mismatch.Category);
        Assert.Empty(await database.Store.LoadTimelineAsync(first.Bot.DirectChatId));
        Assert.Null(await database.Store.TryClaimNextTurnAsync(first.Bot.Id));
    }

    [Fact]
    public async Task Forged_snapshot_with_same_profile_id_but_different_settings_commits_neither_message_nor_turn()
    {
        await using var database = TestDatabase.Create();
        var first = await SeedBotAsync(database, "forged-snapshot");
        var second = await SaveConnectionAsync(database, "forged-snapshot-other");
        var forged = new ModelProfileSnapshot(
            first.Bot.ModelProfile.Id,
            second.Id,
            second.Protocol,
            "forged-model",
            new GenerationOptions(1.5, 999),
            new Dictionary<string, string> { ["seed"] = "forged" });

        AmiraException mismatch = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.CommitHumanMessageAndQueueTurnAsync(
                new HumanMessageCommand(first.Bot.DirectChatId, "forged", first.Bot.Id, forged)).AsTask());

        Assert.Equal(AmiraErrorCodes.SnapshotMismatch, mismatch.Code);
        Assert.Equal(ErrorCategory.DomainRule, mismatch.Category);
        Assert.Empty(await database.Store.LoadTimelineAsync(first.Bot.DirectChatId));
        Assert.Null(await database.Store.TryClaimNextTurnAsync(first.Bot.Id));
    }

    [Fact]
    public async Task Concurrent_claims_for_same_bot_have_exactly_one_winner()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "same-bot");
        await QueueAsync(database, seeded, "one");
        await QueueAsync(database, seeded, "two");

        var claims = await Task.WhenAll(
            Enumerable.Range(0, 12).Select(_ => database.Store.TryClaimNextTurnAsync(seeded.Bot.Id).AsTask()));

        Assert.Single(claims, claim => claim is not null);
        Assert.Equal(1L, await database.ScalarAsync<long>(
            $"SELECT COUNT(*) FROM bot_turns WHERE bot_id = '{seeded.Bot.Id.Value}' AND status = 1;"));
    }

    [Fact]
    public async Task Different_bots_can_each_hold_a_running_claim()
    {
        await using var database = TestDatabase.Create();
        var first = await SeedBotAsync(database, "parallel-a");
        var second = await SeedBotAsync(database, "parallel-b");
        await QueueAsync(database, first, "a");
        await QueueAsync(database, second, "b");

        var claims = await Task.WhenAll(
            database.Store.TryClaimNextTurnAsync(first.Bot.Id).AsTask(),
            database.Store.TryClaimNextTurnAsync(second.Bot.Id).AsTask());

        Assert.All(claims, claim => Assert.NotNull(claim));
        Assert.Equal(2L, await database.ScalarAsync<long>("SELECT COUNT(*) FROM bot_turns WHERE status = 1;"));
    }

    [Fact]
    public async Task Completion_atomically_persists_assistant_message_and_usage()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "complete");
        await QueueAsync(database, seeded, "question");
        var claim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));

        await database.Store.CompleteTurnAsync(
            new CompleteTurnCommand(claim.Turn, "answer\nexact", usage: new TurnUsage(12, 34)),
            claim.ClaimToken);

        var timeline = await database.Store.LoadTimelineAsync(seeded.Bot.DirectChatId);
        Assert.Equal(2, timeline.Count);
        Assert.Equal(MessageAuthor.Bot, timeline[1].Author);
        Assert.Equal("answer\nexact", timeline[1].Revision.Content);
        Assert.Equal(2L, await database.ScalarAsync<long>(
            $"SELECT status FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        Assert.Equal(12L, await database.ScalarAsync<long>(
            $"SELECT input_tokens FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        Assert.Equal(34L, await database.ScalarAsync<long>(
            $"SELECT output_tokens FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
    }

    [Fact]
    public async Task First_token_checkpoint_is_claim_authoritative_idempotent_and_queryable()
    {
        await using var database = TestDatabase.Create();
        SeededBot seeded = await SeedBotAsync(database, "first-token");
        await QueueAsync(database, seeded, "question");
        ClaimedTurn claim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));

        AmiraException stale = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.RecordFirstTokenAsync(claim.Turn.Id, TurnClaimToken.New()).AsTask());
        await database.Store.RecordFirstTokenAsync(claim.Turn.Id, claim.ClaimToken);
        TurnView first = Assert.IsType<TurnView>(await database.Store.GetTurnAsync(claim.Turn.Id));
        await database.Store.RecordFirstTokenAsync(claim.Turn.Id, claim.ClaimToken);
        TurnView repeated = Assert.IsType<TurnView>(await database.Store.GetTurnAsync(claim.Turn.Id));
        await database.Store.CompleteTurnAsync(
            new CompleteTurnCommand(claim.Turn, "answer", usage: new TurnUsage(12, 34)),
            claim.ClaimToken);
        TurnView completed = Assert.IsType<TurnView>(await database.Store.GetTurnAsync(claim.Turn.Id));

        Assert.Equal(AmiraErrorCodes.StaleClaim, stale.Code);
        Assert.NotNull(first.FirstTokenAt);
        Assert.Equal(first.FirstTokenAt, repeated.FirstTokenAt);
        Assert.NotNull(first.QueueWaitDuration);
        Assert.NotNull(first.TimeToFirstToken);
        Assert.Null(first.GenerationDuration);
        Assert.Null(first.EndToEndDuration);
        Assert.Equal(first.FirstTokenAt, completed.FirstTokenAt);
        Assert.NotNull(completed.GenerationDuration);
        Assert.NotNull(completed.EndToEndDuration);
        Assert.Equal(46, completed.Usage?.TotalTokens);
    }

    [Fact]
    public async Task Stale_completion_is_rejected_without_leaving_an_assistant_message()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "stale");
        await QueueAsync(database, seeded, "question");
        var claim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));

        AmiraException stale = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.CompleteTurnAsync(
                new CompleteTurnCommand(claim.Turn, "must not persist"),
                TurnClaimToken.New()).AsTask());
        Assert.Equal("stale_claim", stale.Code);

        Assert.Single(await database.Store.LoadTimelineAsync(seeded.Bot.DirectChatId));
        Assert.Equal(1L, await database.ScalarAsync<long>(
            $"SELECT status FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
    }

    [Fact]
    public async Task Failure_is_persisted_and_a_stale_failure_is_rejected()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "failure");
        await QueueAsync(database, seeded, "question");
        var claim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));

        AmiraException stale = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.FailTurnAsync(
                claim.Turn.Id,
                TurnClaimToken.New(),
                new AmiraError("sentinel", ErrorCategory.Provider, "wrong")).AsTask());
        Assert.Equal("stale_claim", stale.Code);
        Assert.Equal(ErrorCategory.Concurrency, stale.Category);
        await database.Store.RecordFirstTokenAsync(claim.Turn.Id, claim.ClaimToken);
        await database.Store.FailTurnAsync(
            claim.Turn.Id,
            claim.ClaimToken,
            new AmiraError("sentinel", ErrorCategory.Provider, new string('m', 1_400), true));

        Assert.Equal(3L, await database.ScalarAsync<long>(
            $"SELECT status FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        Assert.Equal(8L, await database.ScalarAsync<long>(
            $"SELECT length(failure_code) FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        Assert.Equal(1_400L, await database.ScalarAsync<long>(
            $"SELECT length(failure_message) FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        Assert.Equal(1L, await database.ScalarAsync<long>(
            $"SELECT failure_transient FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        TurnView failed = Assert.IsType<TurnView>(await database.Store.GetTurnAsync(claim.Turn.Id));
        Assert.NotNull(failed.FirstTokenAt);
        Assert.NotNull(failed.GenerationDuration);
    }

    [Fact]
    public async Task Stop_cancels_queued_but_running_worker_retains_claim_until_provider_exit()
    {
        await using var database = TestDatabase.Create();
        var queuedSeed = await SeedBotAsync(database, "queued-stop");
        var queued = await QueueAsync(database, queuedSeed, "queued");
        DurableStopRequestResult queuedStop = await database.Store.RequestStopAsync(queued.Turn.Id);
        Assert.True(queuedStop.StopRequested);
        Assert.True(queuedStop.Cancelled);

        var runningSeed = await SeedBotAsync(database, "running-stop");
        await QueueAsync(database, runningSeed, "running");
        var claim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(runningSeed.Bot.Id));
        await database.Store.RecordFirstTokenAsync(claim.Turn.Id, claim.ClaimToken);
        DurableStopRequestResult runningStop = await database.Store.RequestStopAsync(claim.Turn.Id);
        Assert.True(runningStop.StopRequested);
        Assert.False(runningStop.Cancelled);
        Assert.Equal(default, await database.Store.RequestStopAsync(claim.Turn.Id));

        Assert.Null(await database.Store.TryClaimNextTurnAsync(queuedSeed.Bot.Id));
        Assert.Equal(4L, await database.ScalarAsync<long>(
            $"SELECT status FROM bot_turns WHERE turn_id = '{queued.Turn.Id.Value}';"));
        Assert.Equal(1L, await database.ScalarAsync<long>(
            $"SELECT stop_requested FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        Assert.Equal(1L, await database.ScalarAsync<long>(
            $"SELECT status FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        Assert.Equal(claim.ClaimToken.Value, await database.ScalarAsync<string>(
            $"SELECT claim_token FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        AmiraException stoppedCompletion = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.CompleteTurnAsync(new CompleteTurnCommand(claim.Turn, "late"), claim.ClaimToken).AsTask());
        Assert.Equal("turn_stop_requested", stoppedCompletion.Code);
        AmiraException stoppedFailure = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.FailTurnAsync(claim.Turn.Id, claim.ClaimToken, new AmiraError("late", ErrorCategory.Provider, "late")).AsTask());
        Assert.Equal("turn_stop_requested", stoppedFailure.Code);

        await database.Store.CancelClaimedTurnAsync(claim.Turn.Id, claim.ClaimToken);
        Assert.Equal(4L, await database.ScalarAsync<long>(
            $"SELECT status FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        TurnView cancelled = Assert.IsType<TurnView>(await database.Store.GetTurnAsync(claim.Turn.Id));
        Assert.NotNull(cancelled.FirstTokenAt);
        Assert.NotNull(cancelled.GenerationDuration);
    }

    [Fact]
    public async Task Stop_does_not_mutate_a_terminal_turn()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "terminal-stop");
        await QueueAsync(database, seeded, "question");
        var claim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));
        await database.Store.CompleteTurnAsync(new CompleteTurnCommand(claim.Turn, "done"), claim.ClaimToken);
        var before = await database.ScalarAsync<string>(
            $"SELECT finished_at FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';");

        Assert.Equal(default, await database.Store.RequestStopAsync(claim.Turn.Id));

        Assert.Equal(2L, await database.ScalarAsync<long>(
            $"SELECT status FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        Assert.Equal(0L, await database.ScalarAsync<long>(
            $"SELECT stop_requested FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
        Assert.Equal(before, await database.ScalarAsync<string>(
            $"SELECT finished_at FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';"));
    }

    [Fact]
    public async Task Retry_preserves_lineage_triggers_snapshot_and_does_not_duplicate_human_message()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "retry");
        var queued = await QueueAsync(database, seeded, "only human");
        var claim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));
        await database.Store.RecordFirstTokenAsync(claim.Turn.Id, claim.ClaimToken);
        await database.Store.FailTurnAsync(
            claim.Turn.Id,
            claim.ClaimToken,
            new AmiraError("temporary", ErrorCategory.Provider, "try again", true));

        var retry = await database.Store.RetryTurnAsync(claim.Turn.Id);

        Assert.NotEqual(claim.Turn.Id, retry.Id);
        Assert.Equal(2, retry.Attempt);
        Assert.Equal(claim.Turn.Id, retry.RetryOfTurnId);
        Assert.Equal(queued.Message.Id, Assert.Single(retry.TriggerMessageIds));
        Assert.Equal(claim.Turn.ModelProfileSnapshot.ModelProfileId, retry.ModelProfileSnapshot.ModelProfileId);
        Assert.Equal(claim.Turn.ModelProfileSnapshot.ConnectionId, retry.ModelProfileSnapshot.ConnectionId);
        Assert.Equal(claim.Turn.ModelProfileSnapshot.Protocol, retry.ModelProfileSnapshot.Protocol);
        Assert.Equal(claim.Turn.ModelProfileSnapshot.Model, retry.ModelProfileSnapshot.Model);
        Assert.Equal(
            claim.Turn.ModelProfileSnapshot.GenerationOptions,
            retry.ModelProfileSnapshot.GenerationOptions);
        Assert.Equal("retry", retry.ModelProfileSnapshot.ProviderOptions["seed"]);
        Assert.Null(retry.FirstTokenAt);
        Assert.Single(await database.Store.LoadTimelineAsync(seeded.Bot.DirectChatId));
        var retryClaim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));
        Assert.Equal(retry.Id, retryClaim.Turn.Id);
        Assert.Equal("retry", retryClaim.Turn.ModelProfileSnapshot.ProviderOptions["seed"]);
    }

    [Fact]
    public async Task Retry_accepts_cancelled_turns_and_rejects_active_turns()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "cancelled-retry");
        var queued = await QueueAsync(database, seeded, "human once");

        AmiraException active = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.RetryTurnAsync(queued.Turn.Id).AsTask());
        Assert.Equal(ErrorCategory.DomainRule, active.Category);
        await database.Store.RequestStopAsync(queued.Turn.Id);

        var retry = await database.Store.RetryTurnAsync(queued.Turn.Id);

        Assert.Equal(BotTurnStatus.Queued, retry.Status);
        Assert.Equal(2, retry.Attempt);
        Assert.Equal(queued.Turn.Id, retry.RetryOfTurnId);
        Assert.Equal(queued.Message.Id, Assert.Single(retry.TriggerMessageIds));
        Assert.Single(await database.Store.LoadTimelineAsync(seeded.Bot.DirectChatId));
    }

    [Fact]
    public async Task Running_stop_keeps_per_bot_serial_until_claim_owner_cancels()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "serial-stop");
        await QueueAsync(database, seeded, "first");
        await QueueAsync(database, seeded, "second");
        ClaimedTurn first = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));

        await database.Store.RequestStopAsync(first.Turn.Id);

        Assert.Null(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));
        await database.Store.CancelClaimedTurnAsync(first.Turn.Id, first.ClaimToken);
        ClaimedTurn second = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));
        Assert.NotEqual(first.Turn.Id, second.Turn.Id);
    }

    [Fact]
    public async Task Complete_and_stop_race_has_one_real_terminal_state_and_never_failed()
    {
        for (var attempt = 0; attempt < 20; attempt++)
        {
            await using var database = TestDatabase.Create();
            var seeded = await SeedBotAsync(database, $"terminal-race-{attempt}");
            await QueueAsync(database, seeded, "question");
            ClaimedTurn claim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(seeded.Bot.Id));

            Task complete = Task.Run(async () =>
            {
                try
                {
                    await database.Store.CompleteTurnAsync(new CompleteTurnCommand(claim.Turn, "answer"), claim.ClaimToken);
                }
                catch (AmiraException exception) when (exception.Code == "turn_stop_requested")
                {
                    await database.Store.CancelClaimedTurnAsync(claim.Turn.Id, claim.ClaimToken);
                }
            });
            Task stop = Task.Run(async () => await database.Store.RequestStopAsync(claim.Turn.Id));
            await Task.WhenAll(complete, stop);

            long status = await database.ScalarAsync<long>($"SELECT status FROM bot_turns WHERE turn_id = '{claim.Turn.Id.Value}';");
            Assert.True(status is 2 or 4, $"Unexpected terminal status {status}.");
            Assert.NotEqual(3, status);
            Assert.Equal(status == 2 ? 2 : 1, (await database.Store.LoadTimelineAsync(seeded.Bot.DirectChatId)).Count);
        }
    }

    [Fact]
    public async Task Explicit_recovery_requeues_or_cancels_orphans_and_unblocks_same_bot_after_restart()
    {
        await using var database = TestDatabase.Create();
        var retrySeed = await SeedBotAsync(database, "recover-retry");
        await QueueAsync(database, retrySeed, "retry me");
        ClaimedTurn retryClaim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(retrySeed.Bot.Id));
        await database.Store.RecordFirstTokenAsync(retryClaim.Turn.Id, retryClaim.ClaimToken);
        var cancelSeed = await SeedBotAsync(database, "recover-cancel");
        await QueueAsync(database, cancelSeed, "cancel me");
        ClaimedTurn cancelClaim = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(cancelSeed.Bot.Id));
        await database.Store.RecordFirstTokenAsync(cancelClaim.Turn.Id, cancelClaim.ClaimToken);
        await database.Store.RequestStopAsync(cancelClaim.Turn.Id);

        database.DisposeStore();
        database.ReopenStore();
        await database.Store.InitializeAsync();
        Assert.Null(await database.Store.TryClaimNextTurnAsync(retrySeed.Bot.Id));

        await database.Store.RecoverInterruptedTurnsAsync();

        ClaimedTurn recovered = Assert.IsType<ClaimedTurn>(await database.Store.TryClaimNextTurnAsync(retrySeed.Bot.Id));
        Assert.Equal(retryClaim.Turn.Id, recovered.Turn.Id);
        Assert.Null(recovered.Turn.FirstTokenAt);
        Assert.Equal(4L, await database.ScalarAsync<long>($"SELECT status FROM bot_turns WHERE turn_id = '{cancelClaim.Turn.Id.Value}';"));
        TurnView cancelled = Assert.IsType<TurnView>(await database.Store.GetTurnAsync(cancelClaim.Turn.Id));
        Assert.NotNull(cancelled.FirstTokenAt);
    }

    [Fact]
    public async Task Cross_store_claims_share_one_atomic_claim_snapshot()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "cross-store-claim");
        await QueueAsync(database, seeded, "one");
        await QueueAsync(database, seeded, "two");
        using var secondStore = new SqliteAmiraStore(database.Path);
        await secondStore.InitializeAsync();

        ClaimedTurn?[] claims = await Task.WhenAll(
            Enumerable.Range(0, 20).Select(index =>
                (index % 2 == 0 ? database.Store : secondStore).TryClaimNextTurnAsync(seeded.Bot.Id).AsTask()));

        ClaimedTurn winner = Assert.Single(claims, claim => claim is not null)!;
        Assert.Equal(BotTurnStatus.Running, winner.Turn.Status);
        Assert.Equal("cross-store-claim", winner.Turn.ModelProfileSnapshot.ProviderOptions["seed"]);
    }

    [Fact]
    public async Task Migration_history_rejects_future_versions_and_gaps()
    {
        await using (var future = TestDatabase.Create())
        {
            await future.ExecuteAsync("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (6, 'now');");
            AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() => future.Store.InitializeAsync().AsTask());
            Assert.Equal(AmiraErrorCodes.UnsupportedSchemaVersion, exception.Code);
        }

        await using (var gap = TestDatabase.Create())
        {
            await gap.ExecuteAsync("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (2, 'now');");
            AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() => gap.Store.InitializeAsync().AsTask());
            Assert.Equal("schema_migration_gap", exception.Code);
        }
    }

    [Fact]
    public async Task Aggregate_main_rows_and_children_are_read_from_one_cross_store_snapshot()
    {
        await using var database = TestDatabase.Create();
        ProviderConnection connectionA = ProviderConnection.Create(
            ProviderProtocol.OpenAIResponses,
            "connection-a",
            new Uri("https://a.example.test"),
            CredentialReference.Create("credential-a"),
            extraHeaders: new Dictionary<string, string> { ["state"] = "a" });
        await database.Store.SaveProviderConnectionAsync(connectionA);
        Bot botA = await database.Store.CreateBotAsync(new CreateBotCommand(
            BotProfile.Create("snapshot-bot"),
            ModelProfile.Create(connectionA.Id, "model-a", providerOptions: new Dictionary<string, string> { ["state"] = "a" })));
        ProviderConnection connectionB = ProviderConnection.Rehydrate(
            connectionA.Id,
            connectionA.Protocol,
            "connection-b",
            new Uri("https://b.example.test"),
            connectionA.CredentialReference,
            connectionA.DefaultModel,
            new Dictionary<string, string> { ["state"] = "b" },
            true);
        Bot botB = botA.EditModelSettings(
            connectionA.Id,
            "model-b",
            providerOptions: new Dictionary<string, string> { ["state"] = "b" });
        using var writer = new SqliteAmiraStore(database.Path);
        await writer.InitializeAsync();

        Task writes = Task.Run(async () =>
        {
            for (var iteration = 0; iteration < 100; iteration++)
            {
                bool stateA = iteration % 2 == 0;
                await writer.SaveProviderConnectionAsync(stateA ? connectionA : connectionB);
                await writer.UpdateBotAsync(stateA ? botA : botB);
            }
        });
        for (var iteration = 0; iteration < 100; iteration++)
        {
            ProviderConnection loadedConnection = Assert.IsType<ProviderConnection>(
                await database.Store.GetProviderConnectionAsync(connectionA.Id));
            Assert.Equal(
                loadedConnection.DisplayName == "connection-a" ? "a" : "b",
                loadedConnection.ExtraHeaders["state"]);
            Bot loadedBot = Assert.IsType<Bot>(await database.Store.GetBotAsync(botA.Id));
            Assert.Equal(
                loadedBot.ModelProfile.Model == "model-a" ? "a" : "b",
                loadedBot.ModelProfile.ProviderOptions["state"]);
        }
        await writes;
    }

    [Fact]
    public async Task Foreign_keys_are_enforced_and_message_revision_reference_is_deferred()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "foreign-key");
        await using var connection = await database.OpenRawAsync();
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync();
        var messageId = MessageId.New();
        var missingRevisionId = MessageRevisionId.New();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO messages (
                message_id, chat_id, author, current_revision_id, created_at, status
            ) VALUES ($messageId, $chatId, 0, $revisionId, $createdAt, 0);
            """;
        command.Parameters.AddWithValue("$messageId", messageId.Value);
        command.Parameters.AddWithValue("$chatId", seeded.Bot.DirectChatId.Value);
        command.Parameters.AddWithValue("$revisionId", missingRevisionId.Value);
        command.Parameters.AddWithValue("$createdAt", DateTimeOffset.UtcNow.ToString("O"));

        Assert.Equal(1, await command.ExecuteNonQueryAsync());
        await Assert.ThrowsAsync<SqliteException>(async () => await transaction.CommitAsync());
    }

    [Fact]
    public async Task Invalid_persisted_enum_fails_fast_as_controlled_data_error()
    {
        await using var database = TestDatabase.Create();
        SeededBot seeded = await SeedBotAsync(database, "invalid-enum");
        QueuedMessageResult queued = await QueueAsync(database, seeded, "trigger");
        await using var raw = await database.OpenRawAsync();
        await using var pragma = raw.CreateCommand();
        pragma.CommandText = "PRAGMA ignore_check_constraints=ON;";
        await pragma.ExecuteNonQueryAsync();
        await using var update = raw.CreateCommand();
        update.CommandText = "UPDATE provider_connections SET protocol = 99 WHERE connection_id = $id;";
        update.Parameters.AddWithValue("$id", seeded.Connection.Id.Value);
        await update.ExecuteNonQueryAsync();

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.GetProviderConnectionAsync(seeded.Connection.Id).AsTask());
        Assert.Equal(ErrorCategory.Persistence, exception.Category);

        update.CommandText = "UPDATE bot_turns SET status = 99 WHERE turn_id = $id;";
        update.Parameters.Clear();
        update.Parameters.AddWithValue("$id", queued.Turn.Id.Value);
        await update.ExecuteNonQueryAsync();
        exception = await Assert.ThrowsAsync<AmiraException>(() => database.Store.RetryTurnAsync(queued.Turn.Id).AsTask());
        Assert.Equal(ErrorCategory.Persistence, exception.Category);

        update.CommandText = "UPDATE messages SET author = 99 WHERE message_id = $id;";
        update.Parameters.Clear();
        update.Parameters.AddWithValue("$id", queued.Message.Id.Value);
        await update.ExecuteNonQueryAsync();
        exception = await Assert.ThrowsAsync<AmiraException>(() => database.Store.LoadTimelineAsync(seeded.Bot.DirectChatId).AsTask());
        Assert.Equal(ErrorCategory.Persistence, exception.Category);

        update.CommandText = "UPDATE messages SET author = 0, status = 99 WHERE message_id = $id;";
        await update.ExecuteNonQueryAsync();
        exception = await Assert.ThrowsAsync<AmiraException>(() => database.Store.LoadTimelineAsync(seeded.Bot.DirectChatId).AsTask());
        Assert.Equal(ErrorCategory.Persistence, exception.Category);
    }

    [Fact]
    public async Task Invalid_persisted_provider_uri_is_a_controlled_data_error()
    {
        await using var database = TestDatabase.Create();
        var connection = await SaveConnectionAsync(database, "corrupt-uri");
        await database.ExecuteAsync($"UPDATE provider_connections SET base_url = 'not a uri' WHERE connection_id = '{connection.Id.Value}';");

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.GetProviderConnectionAsync(connection.Id).AsTask());

        Assert.Equal(AmiraErrorCodes.InvalidPersistedValue, exception.Code);
        Assert.Equal(ErrorCategory.Persistence, exception.Category);
    }

    [Fact]
    public async Task Duplicate_persisted_headers_are_a_controlled_data_error()
    {
        await using var database = TestDatabase.Create();
        var connection = await SaveConnectionAsync(database, "duplicate-header");
        await database.ExecuteAsync($"INSERT INTO connection_headers (header_id, connection_id, name, value) VALUES ('duplicate-header-row', '{connection.Id.Value}', 'X-Duplicate', 'one');");
        await database.ExecuteAsync($"INSERT INTO connection_headers (header_id, connection_id, name, value) VALUES ('duplicate-header-row-2', '{connection.Id.Value}', 'X-Duplicate', 'two');");

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.GetProviderConnectionAsync(connection.Id).AsTask());

        Assert.Equal(AmiraErrorCodes.InvalidPersistedValue, exception.Code);
        Assert.Equal(ErrorCategory.Persistence, exception.Category);
    }

    [Fact]
    public async Task Duplicate_persisted_model_options_are_a_controlled_data_error()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "duplicate-model-option");
        await database.ExecuteAsync($"INSERT INTO model_options (option_id, model_profile_id, name, value) VALUES ('duplicate-model-option-row', '{seeded.Bot.ModelProfile.Id.Value}', 'seed', 'duplicate');");

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.GetBotAsync(seeded.Bot.Id).AsTask());

        Assert.Equal(AmiraErrorCodes.InvalidPersistedValue, exception.Code);
        Assert.Equal(ErrorCategory.Persistence, exception.Category);
    }

    [Fact]
    public async Task Duplicate_persisted_turn_options_are_a_controlled_data_error()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "duplicate-turn-option");
        QueuedMessageResult queued = await QueueAsync(database, seeded, "trigger");
        await database.ExecuteAsync($"INSERT INTO turn_options (option_id, turn_id, name, value) VALUES ('duplicate-turn-option-row', '{queued.Turn.Id.Value}', 'seed', 'duplicate');");

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.TryClaimNextTurnAsync(seeded.Bot.Id).AsTask());

        Assert.Equal(AmiraErrorCodes.InvalidPersistedValue, exception.Code);
        Assert.Equal(ErrorCategory.Persistence, exception.Category);
    }

    [Fact]
    public async Task Duplicate_persisted_turn_triggers_are_a_controlled_data_error()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "duplicate-trigger");
        QueuedMessageResult queued = await QueueAsync(database, seeded, "trigger");
        await database.ExecuteAsync($"INSERT INTO turn_triggers (trigger_id, turn_id, ordinal, message_id) VALUES ('duplicate-trigger-row', '{queued.Turn.Id.Value}', 0, '{queued.Message.Id.Value}');");

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.TryClaimNextTurnAsync(seeded.Bot.Id).AsTask());

        Assert.Equal(AmiraErrorCodes.InvalidPersistedValue, exception.Code);
        Assert.Equal(ErrorCategory.Persistence, exception.Category);
    }

    [Fact]
    public async Task Duplicate_persisted_trigger_message_ids_are_a_controlled_data_error()
    {
        await using var database = TestDatabase.Create();
        var seeded = await SeedBotAsync(database, "duplicate-trigger-message");
        QueuedMessageResult queued = await QueueAsync(database, seeded, "trigger");
        await database.ExecuteAsync($"INSERT INTO turn_triggers (trigger_id, turn_id, ordinal, message_id) VALUES ('duplicate-trigger-message-row', '{queued.Turn.Id.Value}', 1, '{queued.Message.Id.Value}');");

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.TryClaimNextTurnAsync(seeded.Bot.Id).AsTask());

        Assert.Equal(AmiraErrorCodes.InvalidPersistedValue, exception.Code);
        Assert.Equal(ErrorCategory.Persistence, exception.Category);
    }

    [Fact]
    public async Task Turn_reader_filters_safe_state_and_terminal_details_across_reopen()
    {
        const string messageCanary = "TURN-QUERY-MESSAGE-CANARY";
        const string optionCanary = "TURN-QUERY-OPTION-CANARY";
        await using var database = TestDatabase.Create();
        await database.Store.InitializeAsync();

        ProviderConnection connectionA = await SaveConnectionAsync(
            database,
            "turn-query-a",
            ProviderProtocol.AnthropicMessages);
        var modelA = ModelProfile.Create(
            connectionA.Id,
            "query-model-a",
            new GenerationOptions(0.2, 144),
            new Dictionary<string, string> { ["private-option"] = optionCanary });
        Bot botA = await database.Store.CreateBotAsync(
            new CreateBotCommand(BotProfile.Create("turn-query-a"), modelA));
        var seededA = new SeededBot(botA, connectionA);
        SeededBot seededB = await SeedBotAsync(database, "turn-query-b");

        QueuedMessageResult failedSeed = await QueueAsync(database, seededA, messageCanary);
        ClaimedTurn failedClaim = Assert.IsType<ClaimedTurn>(
            await database.Store.TryClaimNextTurnAsync(botA.Id));
        var safeFailure = new AmiraError(
            AmiraErrorCodes.ProviderTimeout,
            ErrorCategory.Provider,
            "The provider timed out.",
            true);
        await database.Store.FailTurnAsync(failedClaim.Turn.Id, failedClaim.ClaimToken, safeFailure);

        BotTurn retry = await database.Store.RetryTurnAsync(failedSeed.Turn.Id);
        ClaimedTurn retryClaim = Assert.IsType<ClaimedTurn>(
            await database.Store.TryClaimNextTurnAsync(botA.Id));
        await database.Store.CompleteTurnAsync(
            new CompleteTurnCommand(retryClaim.Turn, "safe reply", usage: new TurnUsage(17, 9)),
            retryClaim.ClaimToken);

        QueuedMessageResult cancelled = await QueueAsync(database, seededA, "cancel me");
        await database.Store.RequestStopAsync(cancelled.Turn.Id);

        QueuedMessageResult running = await QueueAsync(database, seededB, "running secret");
        ClaimedTurn runningClaim = Assert.IsType<ClaimedTurn>(
            await database.Store.TryClaimNextTurnAsync(seededB.Bot.Id));

        database.DisposeStore();
        database.ReopenStore();
        await database.Store.InitializeAsync();

        TurnView failed = Assert.IsType<TurnView>(await database.Store.GetTurnAsync(failedSeed.Turn.Id));
        Assert.Equal(failedSeed.Turn.Id, failed.TurnId);
        Assert.Equal(botA.Id, failed.BotId);
        Assert.Equal(botA.DirectChatId, failed.ChatId);
        Assert.Equal(botA.ModelProfile.Id, failed.ModelProfileId);
        Assert.Equal(connectionA.Id, failed.ConnectionId);
        Assert.Equal(ProviderProtocol.AnthropicMessages, failed.Protocol);
        Assert.Equal("query-model-a", failed.Model);
        Assert.Equal(BotTurnStatus.Failed, failed.Status);
        Assert.Equal(1, failed.Attempt);
        Assert.NotNull(failed.StartedAt);
        Assert.NotNull(failed.FinishedAt);
        Assert.Equal(safeFailure, failed.Failure);
        Assert.Null(failed.RetryOfTurnId);
        Assert.Null(failed.Usage);

        TurnView completedRetry = Assert.IsType<TurnView>(await database.Store.GetTurnAsync(retry.Id));
        Assert.Equal(BotTurnStatus.Completed, completedRetry.Status);
        Assert.Equal(2, completedRetry.Attempt);
        Assert.Equal(failed.TurnId, completedRetry.RetryOfTurnId);
        Assert.Equal(new TurnUsage(17, 9), completedRetry.Usage);
        Assert.Null(completedRetry.Failure);

        TurnView cancelledView = Assert.IsType<TurnView>(await database.Store.GetTurnAsync(cancelled.Turn.Id));
        Assert.Equal(BotTurnStatus.Cancelled, cancelledView.Status);
        Assert.True(cancelledView.StopRequested);
        Assert.Null(cancelledView.StartedAt);
        Assert.Null(cancelledView.FirstTokenAt);
        Assert.Null(cancelledView.QueueWaitDuration);
        Assert.Null(cancelledView.TimeToFirstToken);
        Assert.Null(cancelledView.GenerationDuration);
        Assert.NotNull(cancelledView.EndToEndDuration);

        TurnPage failedPage = await database.Store.QueryTurnsAsync(new TurnQuery(status: BotTurnStatus.Failed));
        Assert.Equal(failed.TurnId, Assert.Single(failedPage.Items).TurnId);
        Assert.Null(failedPage.NextCursor);

        TurnPage completedPage = await database.Store.QueryTurnsAsync(new TurnQuery(
            botId: botA.Id,
            chatId: botA.DirectChatId,
            status: BotTurnStatus.Completed));
        Assert.Equal(completedRetry.TurnId, Assert.Single(completedPage.Items).TurnId);

        TurnPage botBPage = await database.Store.QueryTurnsAsync(new TurnQuery(botId: seededB.Bot.Id));
        TurnView runningView = Assert.Single(botBPage.Items);
        Assert.Equal(running.Turn.Id, runningView.TurnId);
        Assert.Equal(BotTurnStatus.Running, runningView.Status);

        string safeProjection = string.Join('|', failed, completedRetry, cancelledView, runningView);
        Assert.DoesNotContain(messageCanary, safeProjection, StringComparison.Ordinal);
        Assert.DoesNotContain(optionCanary, safeProjection, StringComparison.Ordinal);
        Assert.DoesNotContain(runningClaim.ClaimToken.Value, safeProjection, StringComparison.Ordinal);
        string[] publicProperties = typeof(TurnView).GetProperties().Select(property => property.Name).ToArray();
        Assert.DoesNotContain("ClaimToken", publicProperties);
        Assert.DoesNotContain("ParentActivityContext", publicProperties);
        Assert.DoesNotContain("ProviderOptions", publicProperties);
        Assert.DoesNotContain("TriggerMessageIds", publicProperties);
        Assert.DoesNotContain("Content", publicProperties);

        Assert.Null(await database.Store.GetTurnAsync(BotTurnId.New()));
        TurnPage mismatched = await database.Store.QueryTurnsAsync(new TurnQuery(
            botId: botA.Id,
            chatId: seededB.Bot.DirectChatId));
        Assert.Empty(mismatched.Items);
        Assert.Null(mismatched.NextCursor);
    }

    [Fact]
    public async Task Turn_query_keyset_paging_is_stable_for_equal_timestamps_without_duplicates_or_gaps()
    {
        await using var database = TestDatabase.Create();
        await database.Store.InitializeAsync();
        SeededBot seeded = await SeedBotAsync(database, "turn-keyset");
        var turns = new List<BotTurn>();
        for (int index = 0; index < 7; index++)
        {
            QueuedMessageResult queued = await QueueAsync(database, seeded, $"message {index}");
            turns.Add(queued.Turn);
        }

        var sharedQueuedAt = new DateTimeOffset(2026, 8, 31, 12, 0, 0, TimeSpan.Zero);
        await database.ExecuteAsync($"UPDATE bot_turns SET queued_at = {sharedQueuedAt.Ticks} WHERE bot_id = '{seeded.Bot.Id.Value}';");

        BotTurnId[] expected = turns
            .Select(turn => turn.Id)
            .OrderByDescending(turnId => turnId.Value, StringComparer.Ordinal)
            .ToArray();
        var actual = new List<BotTurnId>();
        TurnCursor? cursor = null;
        var pageSizes = new List<int>();
        do
        {
            TurnPage page = await database.Store.QueryTurnsAsync(new TurnQuery(
                botId: seeded.Bot.Id,
                pageSize: 3,
                before: cursor));
            pageSizes.Add(page.Items.Count);
            actual.AddRange(page.Items.Select(item => item.TurnId));
            cursor = page.NextCursor;
        }
        while (cursor is not null);

        Assert.Equal([3, 3, 1], pageSizes);
        Assert.Equal(expected, actual);
        Assert.Equal(actual.Count, actual.Distinct().Count());

        TurnPage afterOldest = await database.Store.QueryTurnsAsync(new TurnQuery(
            botId: seeded.Bot.Id,
            pageSize: 3,
            before: new TurnCursor(sharedQueuedAt, expected[^1])));
        Assert.Empty(afterOldest.Items);
        Assert.Null(afterOldest.NextCursor);

        TurnPage empty = await database.Store.QueryTurnsAsync(new TurnQuery(botId: BotId.New()));
        Assert.Empty(empty.Items);
        Assert.Null(empty.NextCursor);
    }

    [Fact]
    public async Task Turn_lookup_rejects_empty_identifier_before_querying_sqlite()
    {
        await using var database = TestDatabase.Create();

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.GetTurnAsync(default, TestContext.Current.CancellationToken).AsTask());

        Assert.Equal(AmiraErrorCodes.InvalidTurnQuery, exception.Code);
        Assert.Equal(ErrorCategory.Input, exception.Category);
    }

    [Fact]
    public async Task Turn_view_maps_corrupt_structural_identity_to_persistence_error()
    {
        await using var database = TestDatabase.Create();
        await database.Store.InitializeAsync();
        SeededBot seeded = await SeedBotAsync(database, "turn-view-corruption");
        QueuedMessageResult queued = await QueueAsync(database, seeded, "message");
        await database.ExecuteAsync(
            $"UPDATE bot_turns SET model_profile_id = '' WHERE turn_id = '{queued.Turn.Id.Value}';");

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(() =>
            database.Store.GetTurnAsync(queued.Turn.Id, TestContext.Current.CancellationToken).AsTask());

        Assert.Equal(AmiraErrorCodes.InvalidPersistedValue, exception.Code);
        Assert.Equal(ErrorCategory.Persistence, exception.Category);
    }

    private static async Task<SeededBot> SeedBotAsync(TestDatabase database, string name)
    {
        var connection = await SaveConnectionAsync(database, $"{name}-connection");
        var model = ModelProfile.Create(
            connection.Id,
            $"{name}-model",
            new GenerationOptions(0.4, 256),
            new Dictionary<string, string> { ["seed"] = name });
        var bot = await database.Store.CreateBotAsync(
            new CreateBotCommand(BotProfile.Create(name), model));
        return new SeededBot(bot, connection);
    }

    private static async Task<ProviderConnection> SaveConnectionAsync(
        TestDatabase database,
        string name,
        ProviderProtocol protocol = ProviderProtocol.OpenAIResponses)
    {
        var connection = ProviderConnection.Create(
            protocol,
            name,
            new Uri("http://localhost:4321/"),
            CredentialReference.Create($"{name}-credential"));
        await database.Store.SaveProviderConnectionAsync(connection);
        return connection;
    }

    private static Task<QueuedMessageResult> QueueAsync(
        TestDatabase database,
        SeededBot seeded,
        string content) =>
        database.Store.CommitHumanMessageAndQueueTurnAsync(
            new HumanMessageCommand(
                seeded.Bot.DirectChatId,
                content,
                seeded.Bot.Id,
                seeded.Bot.ModelProfile.Snapshot(seeded.Connection.Protocol))).AsTask();

    private sealed record SeededBot(Bot Bot, ProviderConnection Connection);

    private sealed class TestDatabase : IAsyncDisposable
    {
        private TestDatabase(string path)
        {
            Path = path;
            Store = new SqliteAmiraStore(path);
        }

        public string Path { get; }
        public SqliteAmiraStore Store { get; private set; }

        public static TestDatabase Create() => new(
            System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"amira-{Guid.NewGuid():N}.db"));

        public void DisposeStore() => Store.Dispose();

        public void ReopenStore() => Store = new SqliteAmiraStore(Path);

        public async Task<SqliteConnection> OpenRawAsync()
        {
            var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = Path,
                Mode = SqliteOpenMode.ReadWriteCreate,
                ForeignKeys = true,
                DefaultTimeout = 5,
            }.ToString());
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";
            await command.ExecuteNonQueryAsync();
            return connection;
        }

        public async Task ExecuteAsync(string sql)
        {
            await using var connection = await OpenRawAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = sql;
            await command.ExecuteNonQueryAsync();
        }

        public async Task<T> ScalarAsync<T>(string sql)
        {
            var value = await ScalarOrNullAsync(sql);
            Assert.NotNull(value);
            return (T)Convert.ChangeType(value, typeof(T), System.Globalization.CultureInfo.InvariantCulture);
        }

        public async Task<object?> ScalarOrNullAsync(string sql)
        {
            await using var connection = await OpenRawAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = sql;
            var value = await command.ExecuteScalarAsync();
            return value is DBNull ? null : value;
        }

        public async Task<IReadOnlyList<string>> QueryStringsAsync(string sql)
        {
            await using var connection = await OpenRawAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = sql;
            await using var reader = await command.ExecuteReaderAsync();
            var values = new List<string>();
            while (await reader.ReadAsync())
            {
                values.Add(reader.GetString(0));
            }

            return values;
        }

        public async ValueTask DisposeAsync()
        {
            Store.Dispose();
            SqliteConnection.ClearAllPools();
            foreach (var path in new[] { Path, $"{Path}-wal", $"{Path}-shm", $"{Path}-journal" })
            {
                for (var attempt = 0; attempt < 5 && File.Exists(path); attempt++)
                {
                    try
                    {
                        File.Delete(path);
                    }
                    catch (IOException) when (attempt < 4)
                    {
                        await Task.Delay(20);
                    }
                    catch (UnauthorizedAccessException) when (attempt < 4)
                    {
                        await Task.Delay(20);
                    }
                }
            }
        }
    }
}
