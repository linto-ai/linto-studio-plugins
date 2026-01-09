using System.Text.Json.Serialization;

namespace TeamsMediaBot.Models.Mqtt;

/// <summary>
/// Payload for publishing session mapping to MQTT.
/// This allows other services (like LiveCaptionsServer) to know which
/// sessionId/channelId corresponds to a Teams meeting threadId.
/// </summary>
public class SessionMappingPayload
{
    /// <summary>
    /// The session ID from the Scheduler.
    /// </summary>
    [JsonPropertyName("sessionId")]
    public string SessionId { get; set; } = string.Empty;

    /// <summary>
    /// The channel ID from the Scheduler.
    /// </summary>
    [JsonPropertyName("channelId")]
    public string ChannelId { get; set; } = string.Empty;

    /// <summary>
    /// The Teams meeting thread ID (e.g., "19:meeting_xxx@thread.v2").
    /// </summary>
    [JsonPropertyName("threadId")]
    public string ThreadId { get; set; } = string.Empty;

    /// <summary>
    /// The original Teams meeting URL.
    /// </summary>
    [JsonPropertyName("meetingUrl")]
    public string? MeetingUrl { get; set; }

    /// <summary>
    /// The unique ID of the bot instance that joined this meeting.
    /// </summary>
    [JsonPropertyName("botInstanceId")]
    public string BotInstanceId { get; set; } = string.Empty;

    /// <summary>
    /// Timestamp when the mapping was created.
    /// </summary>
    [JsonPropertyName("timestamp")]
    public DateTime Timestamp { get; set; }

    /// <summary>
    /// Whether display subtitles are enabled for this session.
    /// </summary>
    [JsonPropertyName("enableDisplaySub")]
    public bool EnableDisplaySub { get; set; }
}
