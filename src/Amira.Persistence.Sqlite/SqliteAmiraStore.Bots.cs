using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using SQLite.Framework;
using SQLite.Framework.Exceptions;
using SQLite.Framework.Extensions;

namespace Amira.Persistence.Sqlite;

public sealed partial class SqliteAmiraStore
{
    public async ValueTask<Bot> CreateBotAsync(
        CreateBotCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            Bot bot = Bot.Create(command.Profile, command.ModelProfile);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);

            RequireSingleRow(await _database.Table<BotRow>().AddAsync(new BotRow
            {
                BotId = bot.Id.Value,
                DirectChatId = bot.DirectChatId.Value,
                Archived = false,
                CreatedAt = bot.CreatedAt,
            }, cancellationToken).ConfigureAwait(false));
            RequireSingleRow(await _database.Table<BotProfileRow>().AddAsync(ToRow(bot), cancellationToken).ConfigureAwait(false));
            RequireSingleRow(await _database.Table<ModelProfileRow>().AddAsync(ToModelRow(bot), cancellationToken).ConfigureAwait(false));
            await AddModelOptionsAsync(bot.ModelProfile, cancellationToken).ConfigureAwait(false);
            RequireSingleRow(await _database.Table<ChatRow>().AddAsync(new ChatRow
            {
                ChatId = bot.DirectChatId.Value,
                BotId = bot.Id.Value,
                CreatedAt = bot.CreatedAt,
            }, cancellationToken).ConfigureAwait(false));

            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return bot;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask<Bot?> GetBotAsync(BotId botId, CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            Bot? bot = await LoadBotAsync(botId, cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return bot;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            List<string> ids = await _database.Table<BotRow>()
                .OrderBy(item => item.CreatedAt)
                .ThenBy(item => item.BotId)
                .Select(item => item.BotId)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var bots = new List<Bot>(ids.Count);
            foreach (string id in ids)
            {
                Bot bot = await LoadBotAsync(BotId.Create(id), cancellationToken).ConfigureAwait(false)
                    ?? throw new AmiraException(new(
                        AmiraErrorCodes.BotLoadInconsistent,
                        ErrorCategory.Persistence,
                        "A Bot disappeared while it was being loaded."));
                bots.Add(bot);
            }

            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return bots;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(bot);
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);

            int profileRows = await _database.Table<BotProfileRow>()
                .Where(item => item.BotId == bot.Id.Value && item.ProfileId == bot.Profile.Id.Value)
                .ExecuteUpdateAsync(setters => setters
                    .Set(item => item.Name, bot.Profile.Name)
                    .Set(item => item.Description, bot.Profile.Description)
                    .Set(item => item.Instructions, bot.Profile.Instructions)
                    .Set(item => item.UpdatedAt, bot.Profile.UpdatedAt), cancellationToken)
                .ConfigureAwait(false);
            if (profileRows != 1)
            {
                throw new AmiraException(new(
                    AmiraErrorCodes.BotProfileIdentityMismatch,
                    ErrorCategory.DomainRule,
                    "The Bot profile identity does not match the stored aggregate."));
            }

            int modelRows = await _database.Table<ModelProfileRow>()
                .Where(item => item.BotId == bot.Id.Value && item.ModelProfileId == bot.ModelProfile.Id.Value)
                .ExecuteUpdateAsync(setters => setters
                    .Set(item => item.ConnectionId, bot.ModelProfile.ConnectionId.Value)
                    .Set(item => item.Model, bot.ModelProfile.Model)
                    .Set(item => item.Temperature, bot.ModelProfile.GenerationOptions.Temperature)
                    .Set(item => item.MaxOutputTokens, bot.ModelProfile.GenerationOptions.MaxOutputTokens), cancellationToken)
                .ConfigureAwait(false);
            if (modelRows != 1)
            {
                throw new AmiraException(new(
                    AmiraErrorCodes.ModelProfileIdentityMismatch,
                    ErrorCategory.DomainRule,
                    "The model profile identity does not match the stored Bot aggregate."));
            }

            _ = await _database.Table<ModelOptionRow>()
                .Where(item => item.ModelProfileId == bot.ModelProfile.Id.Value)
                .ExecuteDeleteAsync(cancellationToken)
                .ConfigureAwait(false);
            await AddModelOptionsAsync(bot.ModelProfile, cancellationToken).ConfigureAwait(false);

            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return bot;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default) =>
        SetBotLifecycleAsync(botId, archived: true, cancellationToken);

    public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default) =>
        SetBotLifecycleAsync(botId, archived: false, cancellationToken);

    private async ValueTask<Bot> SetBotLifecycleAsync(
        BotId botId,
        bool archived,
        CancellationToken cancellationToken)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            int rows = await _database.Table<BotRow>()
                .Where(item => item.BotId == botId.Value)
                .ExecuteUpdateAsync(setters => setters.Set(item => item.Archived, archived), cancellationToken)
                .ConfigureAwait(false);
            if (rows == 0)
            {
                throw new AmiraException(new(
                    AmiraErrorCodes.BotNotFound,
                    ErrorCategory.NotFound,
                    "The requested Bot was not found."));
            }

            RequireSingleRow(rows);
            return await LoadBotAsync(botId, cancellationToken).ConfigureAwait(false)
                ?? throw new AmiraException(new(
                    AmiraErrorCodes.BotLoadInconsistent,
                    ErrorCategory.Persistence,
                    "A Bot disappeared after its lifecycle was updated."));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    private async ValueTask<Bot?> LoadBotAsync(BotId botId, CancellationToken cancellationToken)
    {
        BotRow? bot = await _database.Table<BotRow>()
            .SingleOrDefaultAsync(item => item.BotId == botId.Value, cancellationToken)
            .ConfigureAwait(false);
        if (bot is null)
        {
            return null;
        }

        BotProfileRow? profile = await _database.Table<BotProfileRow>()
            .SingleOrDefaultAsync(item => item.BotId == botId.Value, cancellationToken)
            .ConfigureAwait(false);
        ModelProfileRow? model = await _database.Table<ModelProfileRow>()
            .SingleOrDefaultAsync(item => item.BotId == botId.Value, cancellationToken)
            .ConfigureAwait(false);
        if (profile is null || model is null || bot.DirectChatId is null)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.BotLoadInconsistent,
                ErrorCategory.Persistence,
                "The stored Bot aggregate is incomplete."));
        }

        List<ModelOptionRow> optionRows = await _database.Table<ModelOptionRow>()
            .Where(item => item.ModelProfileId == model.ModelProfileId)
            .OrderBy(item => item.Name)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var options = new Dictionary<string, string>(optionRows.Count, StringComparer.Ordinal);
        foreach (ModelOptionRow option in optionRows)
        {
            options.Add(option.Name, option.Value);
        }

        BotProfile domainProfile = BotProfile.Rehydrate(
            BotProfileId.Create(profile.ProfileId),
            profile.Name,
            profile.Description,
            profile.Instructions,
            profile.CreatedAt,
            profile.UpdatedAt);
        ModelProfile domainModel = ModelProfile.Rehydrate(
            ModelProfileId.Create(model.ModelProfileId),
            ProviderConnectionId.Create(model.ConnectionId),
            model.Model,
            new GenerationOptions(model.Temperature, model.MaxOutputTokens),
            options);
        return Bot.Rehydrate(
            botId,
            domainProfile,
            domainModel,
            DirectChatId.Create(bot.DirectChatId),
            bot.CreatedAt,
            bot.Archived ? BotLifecycleState.Archived : BotLifecycleState.Active);
    }

    private async Task AddModelOptionsAsync(ModelProfile modelProfile, CancellationToken cancellationToken)
    {
        ModelOptionRow[] rows = modelProfile.ProviderOptions
            .Select(item => new ModelOptionRow
            {
                OptionId = ChildKey(modelProfile.Id.Value, item.Key),
                ModelProfileId = modelProfile.Id.Value,
                Name = item.Key,
                Value = item.Value,
            })
            .ToArray();
        if (rows.Length > 0)
        {
            _ = await _database.Table<ModelOptionRow>()
                .AddRangeAsync(rows, runInTransaction: false, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private static BotProfileRow ToRow(Bot bot) => new()
    {
        BotId = bot.Id.Value,
        ProfileId = bot.Profile.Id.Value,
        Name = bot.Profile.Name,
        Description = bot.Profile.Description,
        Instructions = bot.Profile.Instructions,
        CreatedAt = bot.Profile.CreatedAt,
        UpdatedAt = bot.Profile.UpdatedAt,
    };

    private static ModelProfileRow ToModelRow(Bot bot) => new()
    {
        ModelProfileId = bot.ModelProfile.Id.Value,
        BotId = bot.Id.Value,
        ConnectionId = bot.ModelProfile.ConnectionId.Value,
        Model = bot.ModelProfile.Model,
        Temperature = bot.ModelProfile.GenerationOptions.Temperature,
        MaxOutputTokens = bot.ModelProfile.GenerationOptions.MaxOutputTokens,
    };
}
