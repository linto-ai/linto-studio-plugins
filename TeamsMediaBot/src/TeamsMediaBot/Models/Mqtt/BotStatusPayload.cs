using System.Text.Json.Serialization;

namespace TeamsMediaBot.Models.Mqtt
{
    /// <summary>
    /// Status payload published to MQTT broker periodically.
    /// </summary>
    public class BotStatusPayload
    {
        /// <summary>
        /// The unique identifier for this bot service instance.
        /// Format: teamsmediabot-{guid}
        /// </summary>
        [JsonPropertyName("uniqueId")]
        public string UniqueId { get; set; } = null!;

        /// <summary>
        /// Whether the bot service is online.
        /// </summary>
        [JsonPropertyName("online")]
        public bool Online { get; set; }

        /// <summary>
        /// The number of active bots (meetings currently being transcribed).
        /// </summary>
        [JsonPropertyName("activeBots")]
        public int ActiveBots { get; set; }

        /// <summary>
        /// The capabilities this bot service supports.
        /// For TeamsMediaBot, this is ["teams"].
        /// </summary>
        [JsonPropertyName("capabilities")]
        public List<string> Capabilities { get; set; } = new() { "teams" };

        /// <summary>
        /// ISO 8601 timestamp when this status was generated.
        /// </summary>
        [JsonPropertyName("on")]
        public string On { get; set; } = null!;
    }
}
