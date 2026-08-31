using System.Globalization;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Client.WinUI;

public sealed record BotDraft(
    string Name,
    string Description,
    string Instructions,
    ProviderConnection? Connection,
    string Model,
    string Temperature,
    string MaxTokens,
    Bot? Editing = null)
{
    public static BotDraft ForCreate(IEnumerable<ProviderConnection> connections) =>
        BotDraftPolicy.ForCreate(connections);

    public static BotDraft ForEdit(Bot bot, IEnumerable<ProviderConnection> connections) =>
        BotDraftPolicy.ForEdit(bot, connections);
}

public static class BotDraftPolicy
{
    public static BotDraft ForCreate(IEnumerable<ProviderConnection> connections)
    {
        ArgumentNullException.ThrowIfNull(connections);
        IReadOnlyList<ProviderConnection> candidates = connections as IReadOnlyList<ProviderConnection>
            ?? [.. connections];
        ProviderConnection? connection = candidates.FirstOrDefault(item => item.Enabled)
            ?? candidates.FirstOrDefault();
        return new BotDraft(
            string.Empty,
            string.Empty,
            string.Empty,
            connection,
            connection?.DefaultModel ?? string.Empty,
            "0.7",
            "1024");
    }

    public static BotDraft ForEdit(Bot bot, IEnumerable<ProviderConnection> connections)
    {
        ArgumentNullException.ThrowIfNull(bot);
        ArgumentNullException.ThrowIfNull(connections);
        ProviderConnection? connection = connections.FirstOrDefault(item => item.Id == bot.ModelProfile.ConnectionId);
        GenerationOptions options = bot.ModelProfile.GenerationOptions;
        return new BotDraft(
            bot.Profile.Name,
            bot.Profile.Description,
            bot.Profile.Instructions,
            connection,
            bot.ModelProfile.Model,
            Format(options.Temperature),
            Format(options.MaxOutputTokens),
            bot);
    }

    public static CreateBotCommand CreateCommand(BotDraft draft)
    {
        ArgumentNullException.ThrowIfNull(draft);
        if (draft.Editing is not null)
            throw ProductError(AmiraErrorCodes.InvalidRequest, ErrorCategory.Input, "An existing Bot cannot be used as a new Bot draft.");
        ValidatedDraft values = Validate(draft);
        BotProfile profile = BotProfile.Create(values.Name, values.Description, values.Instructions);
        ModelProfile model = ModelProfile.Create(values.Connection.Id, values.Model, values.GenerationOptions);
        return new CreateBotCommand(profile, model);
    }

    public static Bot ApplyEdit(BotDraft draft)
    {
        ArgumentNullException.ThrowIfNull(draft);
        Bot current = draft.Editing
            ?? throw ProductError(AmiraErrorCodes.BotRequired, ErrorCategory.Input, "Choose a Bot to edit.");
        ValidatedDraft values = Validate(draft);
        return current
            .RenameOrEditProfile(values.Name, values.Description, values.Instructions)
            .EditModelSettings(
                values.Connection.Id,
                values.Model,
                values.GenerationOptions,
                current.ModelProfile.ProviderOptions);
    }

    private static ValidatedDraft Validate(BotDraft draft)
    {
        ProviderConnection connection = draft.Connection
            ?? throw ProductError(AmiraErrorCodes.ConnectionNotFound, ErrorCategory.Input, "Choose a provider connection.");
        double? temperature = ParseTemperature(draft.Temperature);
        int? maxTokens = ParseMaxTokens(draft.MaxTokens);
        var generationOptions = new GenerationOptions(temperature, maxTokens);

        // The domain constructors remain the authority for name/model rules.
        // These temporary values normalize user text without creating durable IDs.
        string name = RequireText(draft.Name);
        string model = RequireText(draft.Model);
        return new ValidatedDraft(
            name,
            draft.Description ?? string.Empty,
            draft.Instructions ?? string.Empty,
            connection,
            model,
            generationOptions);
    }

    private static string RequireText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw ProductError(AmiraErrorCodes.TextRequired, ErrorCategory.Input, "A text value is required.");
        return value.Trim();
    }

    private static double? ParseTemperature(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out double temperature)
            || !double.IsFinite(temperature))
        {
            throw ProductError(AmiraErrorCodes.InvalidTemperature, ErrorCategory.Input, "Temperature must be a number between 0 and 2.");
        }
        return temperature;
    }

    private static int? ParseMaxTokens(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int maxTokens))
            throw ProductError(AmiraErrorCodes.InvalidMaxOutputTokens, ErrorCategory.Input, "Maximum tokens must be a positive whole number.");
        return maxTokens;
    }

    private static string Format(double? value) =>
        value?.ToString("G17", CultureInfo.InvariantCulture) ?? string.Empty;

    private static string Format(int? value) =>
        value?.ToString(CultureInfo.InvariantCulture) ?? string.Empty;

    private static AmiraException ProductError(string code, ErrorCategory category, string message) =>
        new(new AmiraError(code, category, message));

    private sealed record ValidatedDraft(
        string Name,
        string Description,
        string Instructions,
        ProviderConnection Connection,
        string Model,
        GenerationOptions GenerationOptions);
}

public static class BotManagementPolicy
{
    public static bool CanSelect(Bot? bot) => bot?.LifecycleState == BotLifecycleState.Active;
    public static bool CanEdit(Bot? bot) => bot is not null;
    public static bool CanArchive(Bot? bot) => bot?.LifecycleState == BotLifecycleState.Active;
    public static bool CanRestore(Bot? bot) => bot?.LifecycleState == BotLifecycleState.Archived;
}
