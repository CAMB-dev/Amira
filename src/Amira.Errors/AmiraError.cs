namespace Amira.Errors;

public enum ErrorCategory
{
    Input,
    Configuration,
    DomainRule,
    NotFound,
    Concurrency,
    Provider,
    Persistence,
    Infrastructure
}

/// <summary>A stable product error carried between trusted internal boundaries.</summary>
public readonly record struct AmiraError(string Code, ErrorCategory Category, string Message, bool IsTransient = false);

public sealed class AmiraException : Exception
{
    public AmiraException(AmiraError error) : base(error.Message) => Error = error;

    public AmiraError Error { get; }
    public string Code => Error.Code;
    public ErrorCategory Category => Error.Category;
    public bool IsTransient => Error.IsTransient;
}
