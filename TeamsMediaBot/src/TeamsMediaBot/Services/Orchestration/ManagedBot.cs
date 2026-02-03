using System.Text.Json;
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
        /// Gets the creation time of this managed bot.
        /// </summary>
        public DateTime CreatedAt { get; }

        private EventHandler<AudioDataEventArgs>? _audioHandler;
        private EventHandler<ParticipantEventArgs>? _participantHandler;
        private EventHandler<DominantSpeakerEventArgs>? _speakerHandler;
        private EventHandler? _emptyMeetingHandler;

        /// <summary>
        /// Event raised when the bot should automatically leave the meeting (meeting empty timeout).
        /// </summary>
        public event EventHandler? AutoLeaveRequested;

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
            _logger.LogDebug("[ManagedBot] Audio handler wired");
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
            }
        }

        /// <summary>
        /// Wires up participant and dominant speaker handlers to forward events as JSON to WebSocket.
        /// </summary>
        public void WireSpeakerHandler()
        {
            if (CallHandler == null)
            {
                _logger.LogWarning("[TeamsMediaBot] Cannot wire speaker handler: CallHandler is null");
                return;
            }

            _participantHandler = async (sender, e) =>
            {
                try
                {
                    string json;
                    if (e.Action == "join")
                    {
                        json = JsonSerializer.Serialize(new
                        {
                            type = "participant",
                            action = "join",
                            participant = new { id = e.ParticipantId, name = e.DisplayName }
                        });
                    }
                    else
                    {
                        json = JsonSerializer.Serialize(new
                        {
                            type = "participant",
                            action = "leave",
                            participant = new { id = e.ParticipantId }
                        });
                    }
                    await WebSocket.SendJsonMessageAsync(json);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[TeamsMediaBot] Error sending participant event for bot {Key}", Key);
                }
            };

            _speakerHandler = async (sender, e) =>
            {
                try
                {
                    var json = JsonSerializer.Serialize(new
                    {
                        type = "speaker",
                        timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        speakers = new[] { new { id = e.ParticipantId, energy = 1 } }
                    });
                    await WebSocket.SendJsonMessageAsync(json);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[TeamsMediaBot] Error sending speaker event for bot {Key}", Key);
                }
            };

            CallHandler.ParticipantChanged += _participantHandler;
            CallHandler.DominantSpeakerChanged += _speakerHandler;

            // Subscribe to empty meeting timeout for auto-leave
            _emptyMeetingHandler = (sender, e) =>
            {
                _logger.LogWarning("[ManagedBot] Meeting empty timeout received for {Key}", Key);
                AutoLeaveRequested?.Invoke(this, EventArgs.Empty);
            };
            CallHandler.MeetingEmptyTimeout += _emptyMeetingHandler;

            _logger.LogDebug("[ManagedBot] Speaker handler wired");
        }

        /// <summary>
        /// Unwires the speaker and participant handlers.
        /// </summary>
        public void UnwireSpeakerHandler()
        {
            if (CallHandler != null)
            {
                if (_participantHandler != null)
                {
                    CallHandler.ParticipantChanged -= _participantHandler;
                    _participantHandler = null;
                }
                if (_speakerHandler != null)
                {
                    CallHandler.DominantSpeakerChanged -= _speakerHandler;
                    _speakerHandler = null;
                }
                if (_emptyMeetingHandler != null)
                {
                    CallHandler.MeetingEmptyTimeout -= _emptyMeetingHandler;
                    _emptyMeetingHandler = null;
                }
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            UnwireAudioHandler();
            UnwireSpeakerHandler();
            WebSocket.Dispose();
        }
    }
}
