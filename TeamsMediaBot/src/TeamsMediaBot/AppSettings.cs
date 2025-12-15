using System.ComponentModel.DataAnnotations;

namespace TeamsMediaBot
{
    /// <summary>
    /// MQTT broker transport protocol.
    /// </summary>
    public enum BrokerProtocol
    {
        /// <summary>
        /// Standard TCP connection (ports 1883 or 8883 with TLS).
        /// </summary>
        Tcp,

        /// <summary>
        /// WebSocket connection (ws://) - useful for firewall traversal.
        /// </summary>
        WebSocket,

        /// <summary>
        /// Secure WebSocket connection (wss://) - WebSocket with TLS.
        /// </summary>
        SecureWebSocket
    }

    public class AppSettings
    {
        /// <summary>
        /// Gets or sets the name of the service DNS.
        /// </summary>
        /// <value>The name of the service DNS.</value>
        [Required]
        public string ServiceDnsName { get; set; }

        /// <summary>
        /// Gets or sets the certificate thumbprint.
        /// </summary>
        /// <value>The certificate thumbprint.</value>
        [Required]
        public string CertificateThumbprint { get; set; }

        /// <summary>
        /// Gets or sets the aad application identifier.
        /// </summary>
        /// <value>The aad application identifier.</value>
        [Required]
        public string AadAppId { get; set; }

        /// <summary>
        /// Gets or sets the aad application secret.
        /// </summary>
        /// <value>The aad application secret.</value>
        [Required]
        public string AadAppSecret { get; set; }

        /// <summary>
        /// Gets or sets the instance media internal port.
        /// </summary>
        /// <value>The instance internal port.</value>
        [Required]
        public int MediaInternalPort { get; set; }

        /// <summary>
        /// Gets or sets the instance bot notifications internal port
        /// </summary>
        [Required]
        public int BotInternalPort { get; set; }

        /// <summary>
        /// Gets or sets the call signaling port.
        /// Internal port to listen for new calls load balanced
        /// from 443 => to this local port
        /// </summary>
        /// <value>The call signaling port.</value>
        [Required]
        public int BotCallingInternalPort { get; set; }

        /// <summary>
        /// Gets or sets if the bot should use Speech Service
        /// for converting the audio to a Bot voice
        /// </summary>
        public bool UseSpeechService { get; set; }

        /// <summary>
        /// Gets or sets the Speech Service key
        /// </summary>
        public string SpeechConfigKey { get; set; }

        /// <summary>
        /// Gets or sets the Speech Service region
        /// </summary>
        public string SpeechConfigRegion { get; set; }

        /// <summary>
        /// Gets or sets the Speech Service Bot language
        /// that it will use for speech-to-text and text-to-speech
        /// </summary>
        public string BotLanguage { get; set; }

        // set by dsc script

        /// <summary>
        /// Gets or sets the Load Balancer port for the specific VM instance
        /// used for call notifications
        /// </summary>
        [Required]
        public int BotInstanceExternalPort { get; set; }

        /// <summary>
        /// Gets or sets the Load Balancer port for the specific VM instance
        /// used for media notifications
        /// </summary>
        [Required]
        public int MediaInstanceExternalPort { get; set; }

        /// <summary>
        /// Used for local development to set the ports to be used
        /// with ngrok
        /// </summary>
        public bool UseLocalDevSettings { get; set; }

        /// <summary>
        /// Set by the user only when using local dev settings
        /// since the media settings needs a different URI
        /// </summary>
        [Required]
        public string MediaDnsName { get; set; }

        // MQTT Configuration

        /// <summary>
        /// Gets or sets the MQTT broker host.
        /// </summary>
        public string BrokerHost { get; set; } = "localhost";

        /// <summary>
        /// Gets or sets the MQTT broker port.
        /// </summary>
        public int BrokerPort { get; set; } = 1883;

        /// <summary>
        /// Gets or sets the MQTT broker username.
        /// </summary>
        public string? BrokerUsername { get; set; }

        /// <summary>
        /// Gets or sets the MQTT broker password.
        /// </summary>
        public string? BrokerPassword { get; set; }

        /// <summary>
        /// Gets or sets the MQTT keep alive interval in seconds.
        /// </summary>
        public int BrokerKeepAlive { get; set; } = 60;

        /// <summary>
        /// Gets or sets whether to use TLS/SSL for MQTT connection.
        /// </summary>
        public bool BrokerUseTls { get; set; } = false;

        /// <summary>
        /// Gets or sets whether to allow untrusted/self-signed certificates.
        /// Only use in development environments.
        /// </summary>
        public bool BrokerAllowUntrustedCertificates { get; set; } = false;

        /// <summary>
        /// Gets or sets the MQTT broker transport protocol.
        /// Use WebSocket or SecureWebSocket for firewall traversal.
        /// </summary>
        public BrokerProtocol BrokerProtocol { get; set; } = BrokerProtocol.Tcp;

        /// <summary>
        /// Gets or sets the WebSocket path for MQTT over WebSocket connections.
        /// Common values: "/mqtt", "/ws". Only used when BrokerProtocol is WebSocket or SecureWebSocket.
        /// </summary>
        public string BrokerWebSocketPath { get; set; } = "/mqtt";

        /// <summary>
        /// Gets or sets the bot display name used when joining Teams meetings.
        /// </summary>
        public string BotDisplayName { get; set; } = "Transcription Bot";

        /// <summary>
        /// Gets or sets the Transcriber host to override the host in WebSocket URLs.
        /// If set, replaces the host in websocketUrl from MQTT payloads.
        /// </summary>
        public string? TranscriberHost { get; set; }
    }
}

