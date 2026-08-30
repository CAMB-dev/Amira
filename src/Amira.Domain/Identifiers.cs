namespace Amira.Domain;

/// <summary>Base contract for the strongly typed, non-empty identifiers used by the domain.</summary>
public interface IAmiraId
{
    string Value { get; }
    bool IsEmpty => string.IsNullOrWhiteSpace(Value);
}

/// <summary>Creates an identifier value and rejects blank input.</summary>
internal static class IdValidation
{
    public static string Require(string value, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(value, parameterName);
        if (string.IsNullOrWhiteSpace(value))
            throw new Amira.Errors.AmiraException(new(Amira.Errors.AmiraErrorCodes.InvalidIdentifier, Amira.Errors.ErrorCategory.Input, "An identifier value is required."));
        return value.Trim();
    }
}

public readonly record struct WorkspaceId : IAmiraId
{
    public WorkspaceId(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static WorkspaceId Create(string value) => new(value);
    public static WorkspaceId New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

public readonly record struct BotId : IAmiraId
{
    public BotId(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static BotId Create(string value) => new(value);
    public static BotId New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

public readonly record struct BotProfileId : IAmiraId
{
    public BotProfileId(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static BotProfileId Create(string value) => new(value);
    public static BotProfileId New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

public readonly record struct DirectChatId : IAmiraId
{
    public DirectChatId(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static DirectChatId Create(string value) => new(value);
    public static DirectChatId New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

public readonly record struct MessageId : IAmiraId
{
    public MessageId(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static MessageId Create(string value) => new(value);
    public static MessageId New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

public readonly record struct MessageRevisionId : IAmiraId
{
    public MessageRevisionId(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static MessageRevisionId Create(string value) => new(value);
    public static MessageRevisionId New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

public readonly record struct BotTurnId : IAmiraId
{
    public BotTurnId(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static BotTurnId Create(string value) => new(value);
    public static BotTurnId New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

public readonly record struct ProviderConnectionId : IAmiraId
{
    public ProviderConnectionId(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static ProviderConnectionId Create(string value) => new(value);
    public static ProviderConnectionId New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

public readonly record struct ModelProfileId : IAmiraId
{
    public ModelProfileId(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static ModelProfileId Create(string value) => new(value);
    public static ModelProfileId New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

/// <summary>Opaque name of a secret in an OS credential store; the secret itself never enters Core.</summary>
public readonly record struct CredentialReference : IAmiraId
{
    public CredentialReference(string value) => Value = IdValidation.Require(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static CredentialReference Create(string value) => new(value);
    public override string ToString() => Value ?? string.Empty;
}
