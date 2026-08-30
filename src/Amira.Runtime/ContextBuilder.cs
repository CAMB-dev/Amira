using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Runtime;

public sealed record ContextDiagnostics(
    int IncludedMessageCount,
    int DroppedMessageCount,
    int IncludedCharacters,
    int DroppedCharacters,
    int CharacterBudget);

public sealed record ContextBuildResult(ModelRequest Request, ContextDiagnostics Diagnostics);

/// <summary>Builds the temporary provider-neutral context projection from committed archive messages.</summary>
public sealed class ContextBuilder
{
    private readonly IChatStore _store;

    public ContextBuilder(IChatStore store) => _store = store ?? throw new ArgumentNullException(nameof(store));

    public async ValueTask<ContextBuildResult> BuildAsync(
        WorkspaceId workspaceId,
        Bot bot,
        BotTurn turn,
        int characterBudget,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(bot);
        ArgumentNullException.ThrowIfNull(turn);
        if (workspaceId.IsEmpty)
            throw new AmiraException(new(AmiraErrorCodes.WorkspaceRequired, ErrorCategory.Input, "A workspace is required."));
        if (characterBudget <= 0) throw new ArgumentOutOfRangeException(nameof(characterBudget));
        if (turn.BotId != bot.Id || turn.ChatId != bot.DirectChatId)
            throw new InvalidOperationException("The turn does not belong to the requested Bot.");

        using var activity = AmiraTelemetry.Source.StartActivity(AmiraTelemetry.ContextBuildActivity);
        activity?.SetTag(AmiraTelemetry.Tags.BotId, turn.BotId.Value).SetTag(AmiraTelemetry.Tags.ChatId, turn.ChatId.Value).SetTag(AmiraTelemetry.Tags.TurnId, turn.Id.Value);
        IReadOnlyList<ChatMessage> timeline = await _store.LoadTimelineAsync(turn.ChatId, cancellationToken).ConfigureAwait(false);
        var committed = timeline
            .Where(static message => message.Status == MessageStatus.Committed)
            .OrderBy(static message => message.CreatedAt)
            .ThenBy(static message => message.Id.Value, StringComparer.Ordinal)
            .ToArray();
        if (committed.Length == 0)
            throw new AmiraException(new(AmiraErrorCodes.ContextEmpty, ErrorCategory.DomainRule, "No committed messages are available for this turn."));

        int latestIndex = Array.FindLastIndex(committed, message => turn.TriggerMessageIds.Contains(message.Id));
        if (latestIndex < 0)
            throw new AmiraException(new(AmiraErrorCodes.TriggerNotFound, ErrorCategory.NotFound, "The turn trigger is not a committed message."));
        int used = 0;
        var selected = new List<ChatMessage>(committed.Length);
        for (int index = latestIndex; index >= 0; index--)
        {
            ChatMessage message = committed[index];
            int length = message.Revision.Content.Length;
            if (selected.Count == 0 || used + length <= characterBudget)
            {
                selected.Add(message);
                used += length;
            }
            else
            {
                break;
            }
        }
        selected.Reverse();
        var messages = selected.Select(static message => new ModelMessage(
            message.Author == MessageAuthor.Human ? ModelMessageRole.User : ModelMessageRole.Assistant,
            message.Revision.Content)).ToArray();
        int consideredCount = latestIndex + 1;
        int droppedCharacters = committed.Take(consideredCount).Sum(static message => message.Revision.Content.Length) - used;
        var diagnostics = new ContextDiagnostics(selected.Count, consideredCount - selected.Count, used, droppedCharacters, characterBudget);
        var request = new ModelRequest(
            workspaceId,
            bot.Id,
            bot.DirectChatId,
            turn.Id,
            turn.ModelProfileSnapshot,
            messages,
            bot.Profile.Instructions);
        return new ContextBuildResult(request, diagnostics);
    }
}
