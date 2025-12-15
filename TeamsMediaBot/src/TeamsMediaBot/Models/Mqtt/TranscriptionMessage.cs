using System.Text.Json;
using System.Text.Json.Serialization;

namespace TeamsMediaBot.Models.Mqtt
{
    /// <summary>
    /// JSON converter that handles both integer and decimal numbers, converting them to long.
    /// </summary>
    public class FlexibleLongConverter : JsonConverter<long?>
    {
        public override long? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            return reader.TokenType switch
            {
                JsonTokenType.Number when reader.TryGetInt64(out var longVal) => longVal,
                JsonTokenType.Number when reader.TryGetDouble(out var doubleVal) => (long)doubleVal,
                JsonTokenType.Null => null,
                _ => throw new JsonException($"Unexpected token type: {reader.TokenType}")
            };
        }

        public override void Write(Utf8JsonWriter writer, long? value, JsonSerializerOptions options)
        {
            if (value.HasValue)
                writer.WriteNumberValue(value.Value);
            else
                writer.WriteNullValue();
        }
    }

    /// <summary>
    /// JSON converter for non-nullable long that handles both integer and decimal numbers.
    /// </summary>
    public class FlexibleLongNonNullableConverter : JsonConverter<long>
    {
        public override long Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            return reader.TokenType switch
            {
                JsonTokenType.Number when reader.TryGetInt64(out var longVal) => longVal,
                JsonTokenType.Number when reader.TryGetDouble(out var doubleVal) => (long)doubleVal,
                _ => throw new JsonException($"Unexpected token type: {reader.TokenType}")
            };
        }

        public override void Write(Utf8JsonWriter writer, long value, JsonSerializerOptions options)
        {
            writer.WriteNumberValue(value);
        }
    }

    /// <summary>
    /// Transcription message received from the Transcriber via MQTT.
    /// </summary>
    public class TranscriptionMessage
    {
        /// <summary>
        /// The ASR provider used (e.g., "microsoft", "amazon", "linto").
        /// </summary>
        [JsonPropertyName("asr")]
        public string? Asr { get; set; }

        /// <summary>
        /// The language of the transcription.
        /// </summary>
        [JsonPropertyName("language")]
        public string? Language { get; set; }

        /// <summary>
        /// The transcribed text.
        /// </summary>
        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;

        /// <summary>
        /// Start timestamp (Unix milliseconds).
        /// </summary>
        [JsonPropertyName("start")]
        [JsonConverter(typeof(FlexibleLongConverter))]
        public long? Start { get; set; }

        /// <summary>
        /// End timestamp (Unix milliseconds).
        /// </summary>
        [JsonPropertyName("end")]
        [JsonConverter(typeof(FlexibleLongConverter))]
        public long? End { get; set; }

        /// <summary>
        /// The speaker ID if diarization is enabled.
        /// </summary>
        [JsonPropertyName("speakerId")]
        public string? SpeakerId { get; set; }

        /// <summary>
        /// Word-level timing information.
        /// </summary>
        [JsonPropertyName("words")]
        public List<WordTiming>? Words { get; set; }

        /// <summary>
        /// Translations of the text in different languages.
        /// </summary>
        [JsonPropertyName("translations")]
        public Dictionary<string, string>? Translations { get; set; }
    }

    /// <summary>
    /// Word-level timing information.
    /// </summary>
    public class WordTiming
    {
        /// <summary>
        /// The word.
        /// </summary>
        [JsonPropertyName("word")]
        public string Word { get; set; } = string.Empty;

        /// <summary>
        /// Start timestamp (Unix milliseconds).
        /// </summary>
        [JsonPropertyName("start")]
        [JsonConverter(typeof(FlexibleLongNonNullableConverter))]
        public long Start { get; set; }

        /// <summary>
        /// End timestamp (Unix milliseconds).
        /// </summary>
        [JsonPropertyName("end")]
        [JsonConverter(typeof(FlexibleLongNonNullableConverter))]
        public long End { get; set; }
    }
}
