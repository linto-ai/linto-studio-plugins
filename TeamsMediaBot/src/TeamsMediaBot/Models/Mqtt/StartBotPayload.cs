using System.Text.Json;
using System.Text.Json.Serialization;

namespace TeamsMediaBot.Models.Mqtt
{
    /// <summary>
    /// JSON converter that handles translation entries as either plain strings ("fr")
    /// or objects with a "target" field ({"target": "fr", "mode": "discrete"}).
    /// Always deserializes to List&lt;string&gt; containing only the language codes.
    /// </summary>
    public class TranslationListConverter : JsonConverter<List<string>?>
    {
        public override List<string>? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            if (reader.TokenType == JsonTokenType.Null)
                return null;

            if (reader.TokenType != JsonTokenType.StartArray)
                throw new JsonException("Expected array for translations");

            var result = new List<string>();
            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.EndArray)
                    return result;

                if (reader.TokenType == JsonTokenType.String)
                {
                    var value = reader.GetString();
                    if (value != null) result.Add(value);
                }
                else if (reader.TokenType == JsonTokenType.StartObject)
                {
                    string? target = null;
                    while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
                    {
                        if (reader.TokenType == JsonTokenType.PropertyName)
                        {
                            var prop = reader.GetString();
                            reader.Read();
                            if (prop == "target" && reader.TokenType == JsonTokenType.String)
                                target = reader.GetString();
                        }
                    }
                    if (target != null) result.Add(target);
                }
            }
            return result;
        }

        public override void Write(Utf8JsonWriter writer, List<string>? value, JsonSerializerOptions options)
        {
            if (value == null)
            {
                writer.WriteNullValue();
                return;
            }
            writer.WriteStartArray();
            foreach (var item in value)
                writer.WriteStringValue(item);
            writer.WriteEndArray();
        }
    }

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
        [JsonConverter(typeof(TranslationListConverter))]
        public List<string>? Translations { get; set; }
    }
}
