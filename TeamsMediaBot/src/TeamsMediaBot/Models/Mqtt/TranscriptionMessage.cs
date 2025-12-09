using System.Text.Json.Serialization;

namespace TeamsMediaBot.Models.Mqtt
{
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
        public long? Start { get; set; }

        /// <summary>
        /// End timestamp (Unix milliseconds).
        /// </summary>
        [JsonPropertyName("end")]
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
        public long Start { get; set; }

        /// <summary>
        /// End timestamp (Unix milliseconds).
        /// </summary>
        [JsonPropertyName("end")]
        public long End { get; set; }
    }
}
