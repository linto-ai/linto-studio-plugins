using System.Text.Json.Serialization;

namespace TeamsMediaBot.Models.Mqtt
{
    /// <summary>
    /// Payload received when the Scheduler sends a stopbot command.
    /// </summary>
    public class StopBotPayload
    {
        /// <summary>
        /// The session ID to stop.
        /// </summary>
        [JsonPropertyName("sessionId")]
        [JsonConverter(typeof(StringOrNumberConverter))]
        public string SessionId { get; set; } = null!;

        /// <summary>
        /// The channel ID to stop.
        /// </summary>
        [JsonPropertyName("channelId")]
        [JsonConverter(typeof(StringOrNumberConverter))]
        public string ChannelId { get; set; } = null!;
    }
}
