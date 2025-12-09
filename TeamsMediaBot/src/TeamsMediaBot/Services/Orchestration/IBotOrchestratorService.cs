namespace TeamsMediaBot.Services.Orchestration
{
    /// <summary>
    /// Interface for the bot orchestrator service that manages active bots.
    /// </summary>
    public interface IBotOrchestratorService
    {
        /// <summary>
        /// Gets the number of currently active bots.
        /// </summary>
        int ActiveBotCount { get; }

        /// <summary>
        /// Initializes the orchestrator and starts listening for commands.
        /// </summary>
        Task InitializeAsync(CancellationToken cancellationToken = default);

        /// <summary>
        /// Shuts down the orchestrator and all active bots.
        /// </summary>
        Task ShutdownAsync();

        /// <summary>
        /// Gets a managed bot by session and channel ID.
        /// </summary>
        ManagedBot? GetBot(string sessionId, string channelId);
    }
}
