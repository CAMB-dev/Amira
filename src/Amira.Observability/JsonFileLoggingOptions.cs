using Microsoft.Extensions.Logging;

namespace Amira.Observability;

public sealed record JsonFileLoggingOptions
{
    public string DirectoryPath { get; init; } = "logs";
    public string FileNamePrefix { get; init; } = "amira";
    public LogLevel MinimumLevel { get; init; } = LogLevel.Information;
    public long FileSizeLimitBytes { get; init; } = 10 * 1024 * 1024;
    public int RetainedFileCountLimit { get; init; } = 14;
    public TimeSpan RetainedFileTimeLimit { get; init; } = TimeSpan.FromDays(14);
    public int AsyncBufferSize { get; init; } = 10_000;
    public bool BlockWhenFull { get; init; }
}
