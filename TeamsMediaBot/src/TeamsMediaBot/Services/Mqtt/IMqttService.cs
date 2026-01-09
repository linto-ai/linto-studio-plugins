namespace TeamsMediaBot.Services.Mqtt
{
    /// <summary>
    /// Interface for MQTT service operations.
    /// </summary>
    public interface IMqttService
    {
        /// <summary>
        /// Gets the unique identifier for this bot service instance.
        /// </summary>
        string UniqueId { get; }

        /// <summary>
        /// Gets whether the MQTT client is connected.
        /// </summary>
        bool IsConnected { get; }

        /// <summary>
        /// Event raised when a startbot command is received.
        /// </summary>
        event EventHandler<Models.Mqtt.StartBotPayload> OnStartBot;

        /// <summary>
        /// Event raised when a stopbot command is received.
        /// </summary>
        event EventHandler<Models.Mqtt.StopBotPayload> OnStopBot;

        /// <summary>
        /// Connects to the MQTT broker.
        /// </summary>
        Task ConnectAsync(CancellationToken cancellationToken = default);

        /// <summary>
        /// Disconnects from the MQTT broker.
        /// </summary>
        Task DisconnectAsync();

        /// <summary>
        /// Publishes the bot status to the broker.
        /// </summary>
        /// <param name="activeBots">The number of active bots.</param>
        Task PublishStatusAsync(int activeBots);

        /// <summary>
        /// Publishes a meeting-joined event to notify TeamsAppService.
        /// </summary>
        /// <param name="sessionId">The session ID.</param>
        /// <param name="channelId">The channel ID.</param>
        /// <param name="threadId">The Teams thread ID.</param>
        /// <param name="translations">Optional list of translation language codes (BCP47).</param>
        Task PublishMeetingJoinedAsync(string sessionId, string channelId, string threadId, List<string>? translations = null);

        /// <summary>
        /// Publishes a meeting-left event to notify TeamsAppService.
        /// </summary>
        /// <param name="sessionId">The session ID.</param>
        /// <param name="channelId">The channel ID.</param>
        /// <param name="threadId">The Teams thread ID.</param>
        Task PublishMeetingLeftAsync(string sessionId, string channelId, string threadId);

        /// <summary>
        /// Subscribes to transcription topics for a session/channel.
        /// </summary>
        /// <param name="sessionId">The session ID.</param>
        /// <param name="channelId">The channel ID.</param>
        Task SubscribeToTranscriptionsAsync(string sessionId, string channelId);

        /// <summary>
        /// Unsubscribes from transcription topics for a session/channel.
        /// </summary>
        /// <param name="sessionId">The session ID.</param>
        /// <param name="channelId">The channel ID.</param>
        Task UnsubscribeFromTranscriptionsAsync(string sessionId, string channelId);

        /// <summary>
        /// Publishes a session mapping to MQTT for other services to discover
        /// the threadId to sessionId/channelId relationship.
        /// </summary>
        /// <param name="sessionId">The session ID.</param>
        /// <param name="channelId">The channel ID.</param>
        /// <param name="threadId">The Teams meeting thread ID.</param>
        /// <param name="meetingUrl">The Teams meeting URL.</param>
        /// <param name="enableDisplaySub">Whether display subtitles are enabled.</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        Task PublishSessionMappingAsync(
            string sessionId,
            string channelId,
            string threadId,
            string? meetingUrl,
            bool enableDisplaySub,
            CancellationToken cancellationToken = default);

        /// <summary>
        /// Publishes an unmapping message to clear the session mapping.
        /// Called when a bot leaves a meeting.
        /// </summary>
        /// <param name="sessionId">The session ID to unmap.</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        Task PublishSessionUnmappingAsync(string sessionId, CancellationToken cancellationToken = default);
    }
}
