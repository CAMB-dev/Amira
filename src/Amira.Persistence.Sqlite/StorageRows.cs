using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using SQLite.Framework.Attributes;
using SQLite.Framework.Enums;

namespace Amira.Persistence.Sqlite;

[Table("schema_migrations")]
internal sealed class SchemaMigrationRow
{
    [Key]
    [Column("version")]
    public int Version { get; set; }

    [Column("applied_at")]
    public DateTimeOffset AppliedAt { get; set; }
}

[Table("bots")]
internal sealed class BotRow
{
    [Key]
    [Column("bot_id")]
    public string BotId { get; set; } = "";

    [Column("direct_chat_id")]
    [Indexed(IsUnique = true)]
    public string? DirectChatId { get; set; }

    [Column("archived")]
    public bool Archived { get; set; }

    [Column("created_at")]
    public DateTimeOffset CreatedAt { get; set; }
}

[Table("bot_profiles")]
internal sealed class BotProfileRow
{
    [Key]
    [Column("bot_id")]
    [ReferencesTable(typeof(BotRow), OnDelete = SQLiteForeignKeyAction.Cascade)]
    public string BotId { get; set; } = "";

    [Column("profile_id")]
    [Indexed(IsUnique = true)]
    public string ProfileId { get; set; } = "";

    [Column("name")]
    public string Name { get; set; } = "";

    [Column("description")]
    public string Description { get; set; } = "";

    [Column("instructions")]
    public string Instructions { get; set; } = "";

    [Column("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    [Column("updated_at")]
    public DateTimeOffset UpdatedAt { get; set; }
}

[Table("provider_connections")]
internal sealed class ProviderConnectionRow
{
    [Key]
    [Column("connection_id")]
    public string ConnectionId { get; set; } = "";

    [Column("protocol")]
    public int Protocol { get; set; }

    [Column("display_name")]
    public string DisplayName { get; set; } = "";

    [Column("base_url")]
    public string BaseUrl { get; set; } = "";

    [Column("credential_ref")]
    public string CredentialReference { get; set; } = "";

    [Column("default_model")]
    public string? DefaultModel { get; set; }

    [Column("enabled")]
    public bool Enabled { get; set; }
}

[Table("connection_headers")]
internal sealed class ConnectionHeaderRow
{
    [Key]
    [Column("header_id")]
    public string HeaderId { get; set; } = "";

    [Column("connection_id")]
    [Indexed]
    [ReferencesTable(typeof(ProviderConnectionRow), OnDelete = SQLiteForeignKeyAction.Cascade)]
    public string ConnectionId { get; set; } = "";

    [Column("name")]
    public string Name { get; set; } = "";

    [Column("value")]
    public string Value { get; set; } = "";
}

[Table("model_profiles")]
internal sealed class ModelProfileRow
{
    [Key]
    [Column("model_profile_id")]
    public string ModelProfileId { get; set; } = "";

    [Column("bot_id")]
    [Indexed(IsUnique = true)]
    [ReferencesTable(typeof(BotRow), OnDelete = SQLiteForeignKeyAction.Cascade)]
    public string BotId { get; set; } = "";

    [Column("connection_id")]
    [Indexed]
    [ReferencesTable(typeof(ProviderConnectionRow))]
    public string ConnectionId { get; set; } = "";

    [Column("model")]
    public string Model { get; set; } = "";

    [Column("temperature")]
    public double? Temperature { get; set; }

    [Column("max_output_tokens")]
    public int? MaxOutputTokens { get; set; }
}

[Table("model_options")]
internal sealed class ModelOptionRow
{
    [Key]
    [Column("option_id")]
    public string OptionId { get; set; } = "";

    [Column("model_profile_id")]
    [Indexed]
    [ReferencesTable(typeof(ModelProfileRow), OnDelete = SQLiteForeignKeyAction.Cascade)]
    public string ModelProfileId { get; set; } = "";

    [Column("name")]
    public string Name { get; set; } = "";

    [Column("value")]
    public string Value { get; set; } = "";
}

[Table("chats")]
internal sealed class ChatRow
{
    [Key]
    [Column("chat_id")]
    public string ChatId { get; set; } = "";

    [Column("bot_id")]
    [Indexed(IsUnique = true)]
    [ReferencesTable(typeof(BotRow), OnDelete = SQLiteForeignKeyAction.Cascade, Deferred = true)]
    public string BotId { get; set; } = "";

    [Column("created_at")]
    public DateTimeOffset CreatedAt { get; set; }
}

[Table("messages")]
internal sealed class MessageRow
{
    [Key]
    [Column("message_id")]
    public string MessageId { get; set; } = "";

    [Column("chat_id")]
    [Indexed]
    [ReferencesTable(typeof(ChatRow), OnDelete = SQLiteForeignKeyAction.Cascade)]
    public string ChatId { get; set; } = "";

    [Column("author")]
    public int Author { get; set; }

    [Column("current_revision_id")]
    [ReferencesTable(typeof(MessageRevisionRow), Deferred = true)]
    public string CurrentRevisionId { get; set; } = "";

    [Column("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    [Column("status")]
    public int Status { get; set; }
}

[Table("message_revisions")]
internal sealed class MessageRevisionRow
{
    [Key]
    [Column("revision_id")]
    public string RevisionId { get; set; } = "";

    [Column("message_id")]
    [Indexed]
    [ReferencesTable(typeof(MessageRow), OnDelete = SQLiteForeignKeyAction.Cascade, Deferred = true)]
    public string MessageId { get; set; } = "";

    [Column("content")]
    public string Content { get; set; } = "";

    [Column("created_at")]
    public DateTimeOffset CreatedAt { get; set; }

    [Column("replaces_revision_id")]
    [ReferencesTable(typeof(MessageRevisionRow))]
    public string? ReplacesRevisionId { get; set; }
}

[Table("bot_turns")]
internal sealed class BotTurnV1Row
{
    [Key]
    [Column("turn_id")]
    public string TurnId { get; set; } = "";

    [Column("bot_id")]
    [Indexed]
    [ReferencesTable(typeof(BotRow))]
    public string BotId { get; set; } = "";

    [Column("chat_id")]
    [ReferencesTable(typeof(ChatRow))]
    public string ChatId { get; set; } = "";

    [Column("attempt")]
    public int Attempt { get; set; }

    [Column("status")]
    public int Status { get; set; }

    [Column("stop_requested")]
    public bool StopRequested { get; set; }

    [Column("queued_at")]
    public DateTimeOffset QueuedAt { get; set; }

    [Column("started_at")]
    public DateTimeOffset? StartedAt { get; set; }

    [Column("finished_at")]
    public DateTimeOffset? FinishedAt { get; set; }

    [Column("failure_code")]
    public string? FailureCode { get; set; }

    [Column("failure_message")]
    public string? FailureMessage { get; set; }

    [Column("failure_transient")]
    public bool? FailureTransient { get; set; }

    [Column("retry_of_turn_id")]
    public string? RetryOfTurnId { get; set; }

    [Column("claim_token")]
    public string? ClaimToken { get; set; }

    [Column("connection_id")]
    public string ConnectionId { get; set; } = "";

    [Column("model_profile_id")]
    public string ModelProfileId { get; set; } = "";

    [Column("protocol")]
    public int Protocol { get; set; }

    [Column("model")]
    public string Model { get; set; } = "";

    [Column("temperature")]
    public double? Temperature { get; set; }

    [Column("max_output_tokens")]
    public int? MaxOutputTokens { get; set; }
}

[Table("bot_turns")]
internal sealed class BotTurnV2Row
{
    [Key]
    [Column("turn_id")]
    public string TurnId { get; set; } = "";

    [Column("bot_id")]
    [Indexed]
    [ReferencesTable(typeof(BotRow))]
    public string BotId { get; set; } = "";

    [Column("chat_id")]
    [ReferencesTable(typeof(ChatRow))]
    public string ChatId { get; set; } = "";

    [Column("attempt")]
    public int Attempt { get; set; }

    [Column("status")]
    public int Status { get; set; }

    [Column("stop_requested")]
    public bool StopRequested { get; set; }

    [Column("queued_at")]
    public DateTimeOffset QueuedAt { get; set; }

    [Column("started_at")]
    public DateTimeOffset? StartedAt { get; set; }

    [Column("finished_at")]
    public DateTimeOffset? FinishedAt { get; set; }

    [Column("failure_code")]
    public string? FailureCode { get; set; }

    [Column("failure_message")]
    public string? FailureMessage { get; set; }

    [Column("failure_transient")]
    public bool? FailureTransient { get; set; }

    [Column("retry_of_turn_id")]
    public string? RetryOfTurnId { get; set; }

    [Column("claim_token")]
    public string? ClaimToken { get; set; }

    [Column("connection_id")]
    public string ConnectionId { get; set; } = "";

    [Column("model_profile_id")]
    public string ModelProfileId { get; set; } = "";

    [Column("protocol")]
    public int Protocol { get; set; }

    [Column("model")]
    public string Model { get; set; } = "";

    [Column("temperature")]
    public double? Temperature { get; set; }

    [Column("max_output_tokens")]
    public int? MaxOutputTokens { get; set; }

    [Column("input_tokens")]
    public int? InputTokens { get; set; }

    [Column("output_tokens")]
    public int? OutputTokens { get; set; }
}

[Table("bot_turns")]
internal sealed class BotTurnV3Row
{
    [Key]
    [Column("turn_id")]
    public string TurnId { get; set; } = "";

    [Column("bot_id")]
    [Indexed]
    [ReferencesTable(typeof(BotRow))]
    public string BotId { get; set; } = "";

    [Column("chat_id")]
    [ReferencesTable(typeof(ChatRow))]
    public string ChatId { get; set; } = "";

    [Column("attempt")]
    public int Attempt { get; set; }

    [Column("status")]
    public int Status { get; set; }

    [Column("stop_requested")]
    public bool StopRequested { get; set; }

    [Column("queued_at")]
    public DateTimeOffset QueuedAt { get; set; }

    [Column("started_at")]
    public DateTimeOffset? StartedAt { get; set; }

    [Column("finished_at")]
    public DateTimeOffset? FinishedAt { get; set; }

    [Column("failure_code")]
    public string? FailureCode { get; set; }

    [Column("failure_message")]
    public string? FailureMessage { get; set; }

    [Column("failure_transient")]
    public bool? FailureTransient { get; set; }

    [Column("retry_of_turn_id")]
    public string? RetryOfTurnId { get; set; }

    [Column("claim_token")]
    public string? ClaimToken { get; set; }

    [Column("connection_id")]
    public string ConnectionId { get; set; } = "";

    [Column("model_profile_id")]
    public string ModelProfileId { get; set; } = "";

    [Column("protocol")]
    public int Protocol { get; set; }

    [Column("model")]
    public string Model { get; set; } = "";

    [Column("temperature")]
    public double? Temperature { get; set; }

    [Column("max_output_tokens")]
    public int? MaxOutputTokens { get; set; }

    [Column("input_tokens")]
    public int? InputTokens { get; set; }

    [Column("output_tokens")]
    public int? OutputTokens { get; set; }

    [Column("failure_category")]
    public int? FailureCategory { get; set; }
}

[Table("bot_turns")]
internal sealed class BotTurnRow
{
    [Key]
    [Column("turn_id")]
    public string TurnId { get; set; } = "";

    [Column("bot_id")]
    [Indexed]
    [ReferencesTable(typeof(BotRow))]
    public string BotId { get; set; } = "";

    [Column("chat_id")]
    [ReferencesTable(typeof(ChatRow))]
    public string ChatId { get; set; } = "";

    [Column("attempt")]
    public int Attempt { get; set; }

    [Column("status")]
    public int Status { get; set; }

    [Column("stop_requested")]
    public bool StopRequested { get; set; }

    [Column("queued_at")]
    public DateTimeOffset QueuedAt { get; set; }

    [Column("started_at")]
    public DateTimeOffset? StartedAt { get; set; }

    [Column("first_token_at")]
    public DateTimeOffset? FirstTokenAt { get; set; }

    [Column("finished_at")]
    public DateTimeOffset? FinishedAt { get; set; }

    [Column("failure_code")]
    public string? FailureCode { get; set; }

    [Column("failure_message")]
    public string? FailureMessage { get; set; }

    [Column("failure_transient")]
    public bool? FailureTransient { get; set; }

    [Column("retry_of_turn_id")]
    public string? RetryOfTurnId { get; set; }

    [Column("claim_token")]
    public string? ClaimToken { get; set; }

    [Column("connection_id")]
    public string ConnectionId { get; set; } = "";

    [Column("model_profile_id")]
    public string ModelProfileId { get; set; } = "";

    [Column("protocol")]
    public int Protocol { get; set; }

    [Column("model")]
    public string Model { get; set; } = "";

    [Column("temperature")]
    public double? Temperature { get; set; }

    [Column("max_output_tokens")]
    public int? MaxOutputTokens { get; set; }

    [Column("input_tokens")]
    public int? InputTokens { get; set; }

    [Column("output_tokens")]
    public int? OutputTokens { get; set; }

    [Column("failure_category")]
    public int? FailureCategory { get; set; }

    [Column("parent_trace_id")]
    public string? ParentTraceId { get; set; }

    [Column("parent_span_id")]
    public string? ParentSpanId { get; set; }

    [Column("parent_trace_flags")]
    public int? ParentTraceFlags { get; set; }

    [Column("parent_trace_state")]
    public string? ParentTraceState { get; set; }

    [Column("parent_is_remote")]
    public bool? ParentIsRemote { get; set; }
}

[Table("turn_triggers")]
internal sealed class TurnTriggerRow
{
    [Key]
    [Column("trigger_id")]
    public string TriggerId { get; set; } = "";

    [Column("turn_id")]
    [Indexed]
    [ReferencesTable(typeof(BotTurnRow), OnDelete = SQLiteForeignKeyAction.Cascade)]
    public string TurnId { get; set; } = "";

    [Column("ordinal")]
    public int Ordinal { get; set; }

    [Column("message_id")]
    [ReferencesTable(typeof(MessageRow))]
    public string MessageId { get; set; } = "";
}

[Table("turn_options")]
internal sealed class TurnOptionRow
{
    [Key]
    [Column("option_id")]
    public string OptionId { get; set; } = "";

    [Column("turn_id")]
    [Indexed]
    [ReferencesTable(typeof(BotTurnRow), OnDelete = SQLiteForeignKeyAction.Cascade)]
    public string TurnId { get; set; } = "";

    [Column("name")]
    public string Name { get; set; } = "";

    [Column("value")]
    public string Value { get; set; } = "";
}
