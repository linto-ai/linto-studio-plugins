using TeamsMediaBot.Bot;
using TeamsMediaBot.Events;
using TeamsMediaBot.Models.Mqtt;
using TeamsMediaBot.Services.WebSocket;

namespace TeamsMediaBot.Services.Orchestration
{
    /// <summary>
    /// Represents an active bot instance managed by the orchestrator.
    /// </summary>
    public class ManagedBot : IDisposable
    {
        private readonly ILogger _logger;
        private bool _disposed;

        /// <summary>
        /// Gets the unique key for this bot (format: {sessionId}_{channelId}).
        /// </summary>
        public string Key => $"{SessionId}_{ChannelId}";

        /// <summary>
        /// Gets the session ID.
        /// </summary>
        public string SessionId { get; }

        /// <summary>
        /// Gets the channel ID.
        /// </summary>
        public string ChannelId { get; }

        /// <summary>
        /// Gets the Teams thread ID for the meeting.
        /// </summary>
        public string? ThreadId { get; set; }

        /// <summary>
        /// Gets the original startbot payload.
        /// </summary>
        public StartBotPayload Payload { get; }

        /// <summary>
        /// Gets the WebSocket connection to the Transcriber.
        /// </summary>
        public ITranscriberWebSocket WebSocket { get; }

        /// <summary>
        /// Gets the call handler for this Teams meeting.
        /// </summary>
        public CallHandler? CallHandler { get; set; }

        /// <summary>
        /// Gets whether subtitle display is enabled.
        /// </summary>
        public bool EnableDisplaySub { get; }

        /// <summary>
        /// Gets the creation time of this managed bot.
        /// </summary>
        public DateTime CreatedAt { get; }

        /// <summary>
        /// Event handler for audio data from BotMediaStream.
        /// </summary>
        private EventHandler<AudioDataEventArgs>? _audioHandler;

        /// <summary>
        /// Initializes a new instance of the <see cref="ManagedBot"/> class.
        /// </summary>
        public ManagedBot(
            StartBotPayload payload,
            ITranscriberWebSocket webSocket,
            ILogger logger)
        {
            _logger = logger;

            SessionId = payload.Session.Id;
            ChannelId = payload.Channel.Id;
            Payload = payload;
            WebSocket = webSocket;
            EnableDisplaySub = payload.EnableDisplaySub;
            CreatedAt = DateTime.UtcNow;
        }

        /// <summary>
        /// Wires up the audio handler to forward audio from BotMediaStream to WebSocket.
        /// </summary>
        public void WireAudioHandler()
        {
            if (CallHandler?.BotMediaStream == null)
            {
                _logger.LogWarning("[TeamsMediaBot] Cannot wire audio handler: CallHandler or BotMediaStream is null");
                return;
            }

            _audioHandler = async (sender, e) =>
            {
                try
                {
                    await WebSocket.SendAudioAsync(e.AudioData);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[TeamsMediaBot] Error sending audio to WebSocket for bot {Key}", Key);
                }
            };

            CallHandler.BotMediaStream.AudioDataReceived += _audioHandler;
            _logger.LogInformation("[TeamsMediaBot] Audio handler wired for bot {Key}", Key);
        }

        /// <summary>
        /// Unwires the audio handler.
        /// </summary>
        public void UnwireAudioHandler()
        {
            if (CallHandler?.BotMediaStream != null && _audioHandler != null)
            {
                CallHandler.BotMediaStream.AudioDataReceived -= _audioHandler;
                _audioHandler = null;
                _logger.LogInformation("[TeamsMediaBot] Audio handler unwired for bot {Key}", Key);
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            UnwireAudioHandler();
            WebSocket.Dispose();
        }
    }
}
