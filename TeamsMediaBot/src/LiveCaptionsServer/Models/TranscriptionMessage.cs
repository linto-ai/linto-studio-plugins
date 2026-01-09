using System.Text.Json;
using System.Text.Json.Serialization;

namespace LiveCaptionsServer.Models;

/// <summary>
/// JSON converter that handles both integer and decimal numbers, converting them to long.
/// This is necessary because different ASR providers may send timestamps as integers or decimals.
/// </summary>
public sealed class FlexibleLongConverter : JsonConverter<long?>
{
    public override long? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        return reader.TokenType switch
        {
            JsonTokenType.Number when reader.TryGetInt64(out var longVal) => longVal,
            JsonTokenType.Number when reader.TryGetDouble(out var doubleVal) => (long)doubleVal,
            JsonTokenType.Null => null,
            _ => throw new JsonException($"Unexpected token type for long?: {reader.TokenType}")
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
/// Transcription message received from the Transcriber service via MQTT.
/// Topic format: transcriber/out/{sessionId}/{channelId}/{partial|final}
/// </summary>
public sealed class TranscriptionMessage
{
    /// <summary>
    /// The ASR provider used (e.g., "microsoft", "amazon", "linto").
    /// </summary>
    [JsonPropertyName("asr")]
    public string? Asr { get; set; }

    /// <summary>
    /// The language of the transcription (e.g., "fr-FR", "en-US").
    /// </summary>
    [JsonPropertyName("language")]
    public string? Language { get; set; }

    /// <summary>
    /// The transcribed text content.
    /// </summary>
    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;

    /// <summary>
    /// Start timestamp in Unix milliseconds.
    /// </summary>
    [JsonPropertyName("start")]
    [JsonConverter(typeof(FlexibleLongConverter))]
    public long? Start { get; set; }

    /// <summary>
    /// End timestamp in Unix milliseconds.
    /// </summary>
    [JsonPropertyName("end")]
    [JsonConverter(typeof(FlexibleLongConverter))]
    public long? End { get; set; }

    /// <summary>
    /// The speaker identifier if diarization is enabled.
    /// </summary>
    [JsonPropertyName("speakerId")]
    public string? SpeakerId { get; set; }

    /// <summary>
    /// Word-level timing information when available.
    /// </summary>
    [JsonPropertyName("words")]
    public List<WordTiming>? Words { get; set; }

    /// <summary>
    /// Translations of the text in different languages.
    /// Key is the language code, value is the translated text.
    /// </summary>
    [JsonPropertyName("translations")]
    public Dictionary<string, string>? Translations { get; set; }
}

/// <summary>
/// Word-level timing information from the ASR provider.
/// </summary>
public sealed class WordTiming
{
    /// <summary>
    /// The transcribed word.
    /// </summary>
    [JsonPropertyName("word")]
    public string Word { get; set; } = string.Empty;

    /// <summary>
    /// Start timestamp in Unix milliseconds.
    /// </summary>
    [JsonPropertyName("start")]
    [JsonConverter(typeof(FlexibleLongConverter))]
    public long? Start { get; set; }

    /// <summary>
    /// End timestamp in Unix milliseconds.
    /// </summary>
    [JsonPropertyName("end")]
    [JsonConverter(typeof(FlexibleLongConverter))]
    public long? End { get; set; }
}
