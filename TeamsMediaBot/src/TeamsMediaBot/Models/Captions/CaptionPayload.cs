using TeamsMediaBot.Models.Mqtt;

namespace TeamsMediaBot.Models.Captions;

/// <summary>
/// Payload sent to SignalR clients for caption display.
/// </summary>
public sealed class CaptionPayload
{
    /// <summary>
    /// The session identifier (from E-Meeting platform).
    /// </summary>
    public string SessionId { get; init; } = string.Empty;

    /// <summary>
    /// The channel identifier within the session.
    /// </summary>
    public string ChannelId { get; init; } = string.Empty;

    /// <summary>
    /// The transcribed text to display.
    /// </summary>
    public string Text { get; init; } = string.Empty;

    /// <summary>
    /// The speaker identifier if diarization is enabled.
    /// Used to display speaker labels.
    /// </summary>
    public string? SpeakerId { get; init; }

    /// <summary>
    /// The language of the transcription.
    /// </summary>
    public string? Language { get; init; }

    /// <summary>
    /// Whether this is a final transcription or still being updated.
    /// Final transcriptions are complete segments, partial ones may change.
    /// </summary>
    public bool IsFinal { get; init; }

    /// <summary>
    /// Server timestamp when the caption was broadcast.
    /// </summary>
    public DateTime Timestamp { get; init; }

    /// <summary>
    /// Start timestamp in Unix milliseconds (from ASR).
    /// </summary>
    public long? Start { get; init; }

    /// <summary>
    /// End timestamp in Unix milliseconds (from ASR).
    /// </summary>
    public long? End { get; init; }

    /// <summary>
    /// Available translations of the text.
    /// Key is language code, value is translated text.
    /// </summary>
    public Dictionary<string, string>? Translations { get; init; }

    /// <summary>
    /// Creates a CaptionPayload from a TranscriptionMessage.
    /// </summary>
    public static CaptionPayload FromTranscription(
        string sessionId,
        string channelId,
        TranscriptionMessage transcription,
        bool isFinal)
    {
        return new CaptionPayload
        {
            SessionId = sessionId,
            ChannelId = channelId,
            Text = transcription.Text,
            SpeakerId = transcription.SpeakerId,
            Language = transcription.Language,
            IsFinal = isFinal,
            Timestamp = DateTime.UtcNow,
            Start = transcription.Start,
            End = transcription.End,
            Translations = transcription.Translations
        };
    }
}
