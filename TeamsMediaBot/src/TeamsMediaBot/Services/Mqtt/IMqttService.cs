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
        /// Event raised when a transcription message is received.
        /// </summary>
        event EventHandler<(string sessionId, string channelId, Models.Mqtt.TranscriptionMessage message, bool isFinal)> OnTranscription;

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
        /// Subscribes to transcription topics for a specific session/channel.
        /// </summary>
        /// <param name="sessionId">The session ID.</param>
        /// <param name="channelId">The channel ID.</param>
        Task SubscribeToTranscriptionsAsync(string sessionId, string channelId);

        /// <summary>
        /// Unsubscribes from transcription topics for a specific session/channel.
        /// </summary>
        /// <param name="sessionId">The session ID.</param>
        /// <param name="channelId">The channel ID.</param>
        Task UnsubscribeFromTranscriptionsAsync(string sessionId, string channelId);
    }
}
