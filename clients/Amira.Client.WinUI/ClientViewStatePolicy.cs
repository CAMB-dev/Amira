using Amira.Domain;

namespace Amira.Client.WinUI;

public enum BotNavigationState
{
    Loading,
    Content,
    NoEnabledConnections,
    NoBots,
    ArchivedOnly,
    SearchNoResults
}

public enum ConversationState
{
    Loading,
    NoSelection,
    EmptyChat,
    Content
}

public static class ClientViewStatePolicy
{
    public static BotNavigationState ResolveNavigation(
        bool isLoading,
        bool hasEnabledConnections,
        int activeBotCount,
        int archivedBotCount,
        bool hasSearchQuery,
        int visibleBotCount)
    {
        if (isLoading) return BotNavigationState.Loading;
        if (activeBotCount > 0)
        {
            return hasSearchQuery && visibleBotCount == 0
                ? BotNavigationState.SearchNoResults
                : BotNavigationState.Content;
        }
        if (archivedBotCount > 0) return BotNavigationState.ArchivedOnly;
        return hasEnabledConnections
            ? BotNavigationState.NoBots
            : BotNavigationState.NoEnabledConnections;
    }

    public static ConversationState ResolveConversation(
        bool isLoading,
        bool hasSelection,
        int messageCount,
        int streamingTurnCount)
    {
        if (isLoading) return ConversationState.Loading;
        if (!hasSelection) return ConversationState.NoSelection;
        return messageCount > 0 || streamingTurnCount > 0
            ? ConversationState.Content
            : ConversationState.EmptyChat;
    }
}

public static class BotNavigationSelectionPolicy
{
    public static bool ShouldOpen(Bot? candidate, Bot? current) =>
        candidate is not null && candidate.Id != current?.Id;
}
