using Amira.Errors;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Events;
using Serilog.Extensions.Logging;

namespace Amira.Observability;

public static class AmiraLogging
{
    public static ILoggerFactory CreateJsonFileLoggerFactory(JsonFileLoggingOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return new SerilogLoggerFactory(CreateLogger(options), dispose: true);
    }

    public static ILoggerProvider CreateJsonFileLoggerProvider(JsonFileLoggingOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        return new SerilogLoggerProvider(CreateLogger(options), dispose: true);
    }

    private static Serilog.ILogger CreateLogger(JsonFileLoggingOptions options)
    {
        ValidatedOptions validated = Validate(options);

        return new LoggerConfiguration()
            .MinimumLevel.Is(validated.MinimumLevel)
            .WriteTo.Async(
                sink => sink.File(
                    new SafeCompactJsonFormatter(),
                    validated.FilePath,
                    rollingInterval: RollingInterval.Day,
                    fileSizeLimitBytes: validated.FileSizeLimitBytes,
                    retainedFileCountLimit: validated.RetainedFileCountLimit,
                    retainedFileTimeLimit: validated.RetainedFileTimeLimit,
                    rollOnFileSizeLimit: true,
                    shared: false),
                bufferSize: validated.AsyncBufferSize,
                blockWhenFull: validated.BlockWhenFull)
            .CreateLogger();
    }

    private static ValidatedOptions Validate(JsonFileLoggingOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.DirectoryPath))
        {
            throw InvalidConfiguration("The log directory is required.");
        }

        if (string.IsNullOrWhiteSpace(options.FileNamePrefix)
            || options.FileNamePrefix.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            throw InvalidConfiguration("The log file prefix is invalid.");
        }

        if (options.FileSizeLimitBytes <= 0)
        {
            throw InvalidConfiguration("The log file size limit must be positive.");
        }

        if (options.RetainedFileCountLimit <= 0)
        {
            throw InvalidConfiguration("The retained log file count must be positive.");
        }

        if (options.RetainedFileTimeLimit <= TimeSpan.Zero)
        {
            throw InvalidConfiguration("The retained log file time limit must be positive.");
        }

        if (options.AsyncBufferSize <= 0)
        {
            throw InvalidConfiguration("The asynchronous log buffer size must be positive.");
        }

        if (options.MinimumLevel is LogLevel.None)
        {
            throw InvalidConfiguration("The log minimum level cannot be None.");
        }

        string directoryPath;
        try
        {
            directoryPath = Path.GetFullPath(options.DirectoryPath);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            throw InvalidConfiguration("The log directory path is invalid.");
        }

        return new ValidatedOptions(
            Path.Combine(directoryPath, $"{options.FileNamePrefix}-.jsonl"),
            MapLevel(options.MinimumLevel),
            options.FileSizeLimitBytes,
            options.RetainedFileCountLimit,
            options.RetainedFileTimeLimit,
            options.AsyncBufferSize,
            options.BlockWhenFull);
    }

    private static LogEventLevel MapLevel(LogLevel level) => level switch
    {
        LogLevel.Trace => LogEventLevel.Verbose,
        LogLevel.Debug => LogEventLevel.Debug,
        LogLevel.Information => LogEventLevel.Information,
        LogLevel.Warning => LogEventLevel.Warning,
        LogLevel.Error => LogEventLevel.Error,
        LogLevel.Critical => LogEventLevel.Fatal,
        _ => throw InvalidConfiguration("The log minimum level is invalid."),
    };

    private static AmiraException InvalidConfiguration(string message) => new(new AmiraError(
        AmiraErrorCodes.ObservabilityInvalidConfiguration,
        ErrorCategory.Configuration,
        message));

    private sealed record ValidatedOptions(
        string FilePath,
        LogEventLevel MinimumLevel,
        long FileSizeLimitBytes,
        int RetainedFileCountLimit,
        TimeSpan RetainedFileTimeLimit,
        int AsyncBufferSize,
        bool BlockWhenFull);
}
