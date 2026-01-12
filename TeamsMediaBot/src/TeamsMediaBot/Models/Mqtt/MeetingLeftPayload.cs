using System.Text.Json.Serialization;

namespace TeamsMediaBot.Models.Mqtt
{
    /// <summary>
    /// Payload published when the bot leaves a Teams meeting.
    /// Published to: teamsappservice/in/meeting-left
    /// </summary>
    public class MeetingLeftPayload
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
    }
}
