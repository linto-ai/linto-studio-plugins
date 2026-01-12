using System.Text.Json;
using System.Text.Json.Serialization;

namespace TeamsMediaBot.Models.Mqtt
{
    /// <summary>
    /// JSON converter that handles both string and number values, converting them to string.
    /// </summary>
    public class StringOrNumberConverter : JsonConverter<string>
    {
        public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            return reader.TokenType switch
            {
                JsonTokenType.String => reader.GetString(),
                JsonTokenType.Number => reader.GetInt64().ToString(),
                JsonTokenType.Null => null,
                _ => throw new JsonException($"Unexpected token type: {reader.TokenType}")
            };
        }

        public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options)
        {
            writer.WriteStringValue(value);
        }
    }

    /// <summary>
    /// Payload received when the Scheduler sends a startbot command.
    /// </summary>
    public class StartBotPayload
    {
        /// <summary>
        /// Session information containing the session ID and metadata.
        /// </summary>
        [JsonPropertyName("session")]
        public SessionInfo Session { get; set; } = null!;

        /// <summary>
        /// Channel information containing the channel ID and settings.
        /// </summary>
        [JsonPropertyName("channel")]
        public ChannelInfo Channel { get; set; } = null!;

        /// <summary>
        /// The Teams meeting URL to join.
        /// </summary>
        [JsonPropertyName("address")]
        public string Address { get; set; } = null!;

        /// <summary>
        /// The type of bot (should be "teams" for this service).
        /// </summary>
        [JsonPropertyName("botType")]
        public string BotType { get; set; } = null!;

        /// <summary>
        /// The WebSocket URL to connect to for audio streaming.
        /// Format: ws://transcriber:8890/transcriber-ws/{sessionId},{channelIndex}
        /// </summary>
        [JsonPropertyName("websocketUrl")]
        public string WebsocketUrl { get; set; } = null!;
    }

    /// <summary>
    /// Session information from the startbot payload.
    /// </summary>
    public class SessionInfo
    {
        /// <summary>
        /// The unique session identifier.
        /// </summary>
        [JsonPropertyName("id")]
        [JsonConverter(typeof(StringOrNumberConverter))]
        public string Id { get; set; } = null!;

        /// <summary>
        /// The session name.
        /// </summary>
        [JsonPropertyName("name")]
        public string? Name { get; set; }

        /// <summary>
        /// The session status.
        /// </summary>
        [JsonPropertyName("status")]
        public string? Status { get; set; }
    }

    /// <summary>
    /// Channel information from the startbot payload.
    /// </summary>
    public class ChannelInfo
    {
        /// <summary>
        /// The unique channel identifier.
        /// </summary>
        [JsonPropertyName("id")]
        [JsonConverter(typeof(StringOrNumberConverter))]
        public string Id { get; set; } = null!;

        /// <summary>
        /// Whether live transcripts are enabled.
        /// </summary>
        [JsonPropertyName("enableLiveTranscripts")]
        public bool EnableLiveTranscripts { get; set; }

        /// <summary>
        /// The stream status.
        /// </summary>
        [JsonPropertyName("streamStatus")]
        public string? StreamStatus { get; set; }

        /// <summary>
        /// Whether diarization is enabled.
        /// </summary>
        [JsonPropertyName("diarization")]
        public bool Diarization { get; set; }

        /// <summary>
        /// List of translation languages.
        /// </summary>
        [JsonPropertyName("translations")]
        public List<string>? Translations { get; set; }
    }
}
