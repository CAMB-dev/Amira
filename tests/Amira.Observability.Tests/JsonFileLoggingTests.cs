using System.Diagnostics;
using System.Text.Json;
using Amira.Errors;
using Microsoft.Extensions.Logging;

namespace Amira.Observability.Tests;

public sealed partial class JsonFileLoggingTests
{
    private const string SafeMarker = "SAFE_OBSERVABILITY_MARKER";
    private const string PromptCanary = "PROMPT_CANARY_6D889E";
    private const string ResponseCanary = "RESPONSE_CANARY_0D2653";
    private const string ApiKeyCanary = "API_KEY_CANARY_E76938";
    private const string AuthorizationCanary = "AUTH_CANARY_A0D847";
    private const string HeaderCanary = "HEADER_CANARY_08B1EF";
    private const string CredentialCanary = "CREDENTIAL_REF_CANARY_3F2DB1";
    private const string ProviderErrorCanary = "PROVIDER_ERROR_CANARY_62D00B";
    private const string ExceptionCanary = "EXCEPTION_CANARY_634FE2";

    [Fact]
    public void Json_lines_include_stable_context_without_sensitive_values_or_exception_body()
    {
        using var directory = new TemporaryDirectory();
        using var listener = new ActivityListener
        {
            ShouldListenTo = static source => source.Name == "Amira.Observability.Tests",
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            SampleUsingParentId = static (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.AllDataAndRecorded,
        };
        ActivitySource.AddActivityListener(listener);
        using var activitySource = new ActivitySource("Amira.Observability.Tests");
        using Activity activity = activitySource.StartActivity("write", ActivityKind.Internal)
            ?? throw new InvalidOperationException("The test Activity was not created.");

        using (ILoggerFactory factory = AmiraLogging.CreateJsonFileLoggerFactory(new JsonFileLoggingOptions
        {
            DirectoryPath = directory.Path,
            BlockWhenFull = true,
        }))
        {
            ILogger logger = factory.CreateLogger("Amira.Observability.Tests.Canary");
            WriteCanary(
                logger,
                SafeMarker,
                17,
                PromptCanary,
                ResponseCanary,
                ApiKeyCanary,
                AuthorizationCanary,
                HeaderCanary,
                CredentialCanary,
                ProviderErrorCanary,
                new InvalidOperationException(ExceptionCanary));
        }

        string payload = ReadAllLogs(directory.Path);
        Assert.DoesNotContain(PromptCanary, payload, StringComparison.Ordinal);
        Assert.DoesNotContain(ResponseCanary, payload, StringComparison.Ordinal);
        Assert.DoesNotContain(ApiKeyCanary, payload, StringComparison.Ordinal);
        Assert.DoesNotContain(AuthorizationCanary, payload, StringComparison.Ordinal);
        Assert.DoesNotContain(HeaderCanary, payload, StringComparison.Ordinal);
        Assert.DoesNotContain(CredentialCanary, payload, StringComparison.Ordinal);
        Assert.DoesNotContain(ProviderErrorCanary, payload, StringComparison.Ordinal);
        Assert.DoesNotContain(ExceptionCanary, payload, StringComparison.Ordinal);

        using JsonDocument document = JsonDocument.Parse(payload);
        JsonElement root = document.RootElement;
        Assert.Equal(SafeMarker, root.GetProperty("SafeMarker").GetString());
        Assert.Equal(17, root.GetProperty("SafeCount").GetInt32());
        Assert.Equal("Warning", root.GetProperty("level").GetString());
        Assert.Equal("Warning", root.GetProperty("@l").GetString());
        Assert.Equal(7301, root.GetProperty("event_id").GetInt32());
        Assert.Equal("observability.canary", root.GetProperty("event_name").GetString());
        Assert.Equal("Amira.Observability.Tests.Canary", root.GetProperty("SourceContext").GetString());
        Assert.Equal(activity.TraceId.ToHexString(), root.GetProperty("@tr").GetString());
        Assert.Equal(activity.SpanId.ToHexString(), root.GetProperty("@sp").GetString());
        Assert.Equal(TimeSpan.Zero, root.GetProperty("@t").GetDateTimeOffset().Offset);
        Assert.False(root.TryGetProperty("@x", out _));
        Assert.False(root.TryGetProperty("Prompt", out _));
        Assert.False(root.TryGetProperty("Response", out _));
        Assert.False(root.TryGetProperty("ApiKey", out _));
        Assert.False(root.TryGetProperty("Authorization", out _));
        Assert.False(root.TryGetProperty("CustomHeaders", out _));
        Assert.False(root.TryGetProperty("CredentialReference", out _));
        Assert.False(root.TryGetProperty("ProviderErrorMessage", out _));
    }

    [Fact]
    public void Size_roll_and_retention_produce_parseable_bounded_json_lines()
    {
        using var directory = new TemporaryDirectory();
        using (ILoggerFactory factory = AmiraLogging.CreateJsonFileLoggerFactory(new JsonFileLoggingOptions
        {
            DirectoryPath = directory.Path,
            FileSizeLimitBytes = 256,
            RetainedFileCountLimit = 2,
            AsyncBufferSize = 256,
            BlockWhenFull = true,
        }))
        {
            ILogger logger = factory.CreateLogger("Amira.Observability.Tests.Rolling");
            for (int index = 0; index < 40; index++)
            {
                WriteRollingEvent(logger, index, new string('s', 200));
            }
        }

        string[] files = Directory.GetFiles(directory.Path, "*.jsonl", SearchOption.TopDirectoryOnly);
        Assert.InRange(files.Length, 2, 2);
        foreach (string line in files.SelectMany(File.ReadAllLines).Where(static line => line.Length > 0))
        {
            using JsonDocument document = JsonDocument.Parse(line);
            Assert.Equal("Information", document.RootElement.GetProperty("level").GetString());
        }
    }

    [Fact]
    public void Invalid_options_are_configuration_errors()
    {
        AmiraException exception = Assert.Throws<AmiraException>(() =>
            AmiraLogging.CreateJsonFileLoggerFactory(new JsonFileLoggingOptions
            {
                RetainedFileTimeLimit = TimeSpan.Zero,
            }));

        Assert.Equal(AmiraErrorCodes.ObservabilityInvalidConfiguration, exception.Code);
        Assert.Equal(ErrorCategory.Configuration, exception.Category);
    }

    [Fact]
    public void Null_options_are_programming_errors()
    {
        Assert.Throws<ArgumentNullException>(() => AmiraLogging.CreateJsonFileLoggerFactory(null!));
    }

    [LoggerMessage(
        EventId = 7301,
        EventName = "observability.canary",
        Level = LogLevel.Warning,
        Message = "Safe {SafeMarker} {SafeCount} {Prompt} {Response} {ApiKey} {Authorization} {CustomHeaders} {CredentialReference} {ProviderErrorMessage}")]
    private static partial void WriteCanary(
        ILogger logger,
        string safeMarker,
        int safeCount,
        string prompt,
        string response,
        string apiKey,
        string authorization,
        string customHeaders,
        string credentialReference,
        string providerErrorMessage,
        Exception exception);

    [LoggerMessage(
        EventId = 7302,
        EventName = "observability.rolling",
        Level = LogLevel.Information,
        Message = "Rolling event {SafeIndex} {SafePadding}")]
    private static partial void WriteRollingEvent(ILogger logger, int safeIndex, string safePadding);

    private static string ReadAllLogs(string directoryPath)
    {
        string[] lines = Directory.GetFiles(directoryPath, "*.jsonl", SearchOption.TopDirectoryOnly)
            .SelectMany(File.ReadAllLines)
            .Where(static line => line.Length > 0)
            .ToArray();
        return Assert.Single(lines);
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"amira-observability-tests-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}
