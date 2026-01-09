using System.ComponentModel.DataAnnotations;

namespace LiveCaptionsServer.Settings;

/// <summary>
/// MQTT broker transport protocol.
/// </summary>
public enum BrokerProtocol
{
    /// <summary>Standard TCP connection (default).</summary>
    Tcp,
    /// <summary>WebSocket connection (ws://).</summary>
    WebSocket,
    /// <summary>Secure WebSocket connection (wss://).</summary>
    SecureWebSocket
}

/// <summary>
/// Configuration settings for the Live Captions Server.
/// </summary>
public sealed class CaptionsServerSettings
{
    /// <summary>
    /// Configuration section name in appsettings.json.
    /// </summary>
    public const string SectionName = "CaptionsServer";

    /// <summary>
    /// The HTTPS port to listen on. Default is 443.
    /// </summary>
    [Range(1, 65535)]
    public int Port { get; set; } = 443;

    /// <summary>
    /// The SSL certificate thumbprint from the Windows Certificate Store.
    /// Required for HTTPS.
    /// </summary>
    [Required]
    public string CertificateThumbprint { get; set; } = string.Empty;

    /// <summary>
    /// The MQTT broker hostname.
    /// </summary>
    [Required]
    public string BrokerHost { get; set; } = "localhost";

    /// <summary>
    /// The MQTT broker port.
    /// </summary>
    [Range(1, 65535)]
    public int BrokerPort { get; set; } = 1883;

    /// <summary>
    /// Optional MQTT broker username.
    /// </summary>
    public string? BrokerUsername { get; set; }

    /// <summary>
    /// Optional MQTT broker password.
    /// </summary>
    public string? BrokerPassword { get; set; }

    /// <summary>
    /// Whether to use TLS for the MQTT connection.
    /// </summary>
    public bool BrokerUseTls { get; set; }

    /// <summary>
    /// Whether to allow untrusted/self-signed certificates.
    /// Only enable in development environments.
    /// </summary>
    public bool BrokerAllowUntrustedCertificates { get; set; }

    /// <summary>
    /// MQTT broker transport protocol (Tcp, WebSocket, SecureWebSocket).
    /// </summary>
    public BrokerProtocol BrokerProtocol { get; set; } = BrokerProtocol.Tcp;

    /// <summary>
    /// WebSocket path when using WebSocket or SecureWebSocket protocol.
    /// Common values: "/mqtt", "/ws".
    /// </summary>
    public string BrokerWebSocketPath { get; set; } = "/mqtt";

    /// <summary>
    /// MQTT keep-alive interval in seconds.
    /// </summary>
    public int BrokerKeepAlive { get; set; } = 60;

    /// <summary>
    /// The MQTT topic pattern to subscribe to for transcriptions.
    /// Supports wildcards: + (single level) and # (multi-level).
    /// Default: "transcriber/out/#"
    /// </summary>
    public string TranscriptionTopicPattern { get; set; } = "transcriber/out/#";
}
