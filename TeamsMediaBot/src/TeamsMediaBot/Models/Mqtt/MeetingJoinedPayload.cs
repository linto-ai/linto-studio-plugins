using System.Text.Json.Serialization;

namespace TeamsMediaBot.Models.Mqtt
{
    /// <summary>
    /// Payload published when the bot successfully joins a Teams meeting.
    /// Published to: teamsappservice/in/meeting-joined
    /// </summary>
    public class MeetingJoinedPayload
    {
        /// <summary>
        /// The session ID associated with this meeting.
        /// </summary>
        [JsonPropertyName("sessionId")]
        public string SessionId { get; set; } = null!;

        /// <summary>
        /// The channel ID associated with this meeting.
        /// </summary>
        [JsonPropertyName("channelId")]
        public string ChannelId { get; set; } = null!;

        /// <summary>
        /// The Teams thread ID for the meeting.
        /// </summary>
        [JsonPropertyName("threadId")]
        public string ThreadId { get; set; } = null!;

        /// <summary>
        /// ISO 8601 timestamp when the bot joined the meeting.
        /// </summary>
        [JsonPropertyName("joinedAt")]
        public string JoinedAt { get; set; } = null!;
    }
}
