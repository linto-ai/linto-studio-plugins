using System.Text;
using System.Text.Json;
using LiveCaptionsServer.Hubs;
using LiveCaptionsServer.Models;
using LiveCaptionsServer.Settings;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using MQTTnet;
using MQTTnet.Client;
using MQTTnet.Protocol;

namespace LiveCaptionsServer.Services;

/// <summary>
/// Background service that connects to MQTT broker, subscribes to transcription topics,
/// and broadcasts received transcriptions to connected SignalR clients.
///
/// Topic format: transcriber/out/{sessionId}/{channelId}/{partial|final}
/// </summary>
public sealed class MqttTranscriptionService : BackgroundService, IAsyncDisposable
{
    private readonly ILogger<MqttTranscriptionService> _logger;
    private readonly CaptionsServerSettings _settings;
    private readonly IHubContext<CaptionsHub> _hubContext;
    private readonly ISessionMappingCache _mappingCache;
    private readonly IMqttClient _mqttClient;
    private readonly string _clientId;
    private bool _disposed;

    /// <summary>
    /// MQTT topic pattern for session mappings from TeamsMediaBot.
    /// </summary>
    private const string SessionMappingTopicPattern = "session/mapping/#";

    /// <summary>
    /// JSON serializer options for deserializing transcription messages.
    /// </summary>
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public MqttTranscriptionService(
        ILogger<MqttTranscriptionService> logger,
        IOptions<CaptionsServerSettings> settings,
        IHubContext<CaptionsHub> hubContext,
        ISessionMappingCache mappingCache)
    {
        _logger = logger;
        _settings = settings.Value;
        _hubContext = hubContext;
        _mappingCache = mappingCache;
        _clientId = $"livecaptions-{Environment.MachineName}-{Guid.NewGuid():N}";

        var factory = new MqttFactory();
        _mqttClient = factory.CreateMqttClient();

        // Wire up event handlers
        _mqttClient.ApplicationMessageReceivedAsync += OnMessageReceivedAsync;
        _mqttClient.DisconnectedAsync += OnDisconnectedAsync;
        _mqttClient.ConnectedAsync += OnConnectedAsync;

        _logger.LogInformation("[MqttService] Service created with clientId: {ClientId}", _clientId);
    }

    /// <summary>
    /// Main execution loop. Connects to MQTT and keeps the connection alive.
    /// </summary>
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[MqttService] Starting MQTT transcription service");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!_mqttClient.IsConnected)
                {
                    await ConnectAsync(stoppingToken);
                }

                // Keep alive - check connection every 5 seconds
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Normal shutdown
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[MqttService] Error in main loop, will retry in 5 seconds");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }

        _logger.LogInformation("[MqttService] Service stopping");
    }

    /// <summary>
    /// Connects to the MQTT broker and subscribes to transcription topics.
    /// </summary>
    private async Task ConnectAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("[MqttService] Connecting to MQTT broker at {Host}:{Port} (Protocol: {Protocol})",
            _settings.BrokerHost, _settings.BrokerPort, _settings.BrokerProtocol);

        var optionsBuilder = new MqttClientOptionsBuilder()
            .WithClientId(_clientId)
            .WithKeepAlivePeriod(TimeSpan.FromSeconds(_settings.BrokerKeepAlive))
            .WithCleanSession(true);

        // Configure transport protocol (TCP, WebSocket, or SecureWebSocket)
        switch (_settings.BrokerProtocol)
        {
            case BrokerProtocol.WebSocket:
                var wsUri = new Uri($"ws://{_settings.BrokerHost}:{_settings.BrokerPort}{_settings.BrokerWebSocketPath}");
                optionsBuilder.WithWebSocketServer(o => o.WithUri(wsUri.ToString()));
                _logger.LogInformation("[MqttService] Using WebSocket transport: {Uri}", wsUri);
                break;

            case BrokerProtocol.SecureWebSocket:
                var wssUri = new Uri($"wss://{_settings.BrokerHost}:{_settings.BrokerPort}{_settings.BrokerWebSocketPath}");
                optionsBuilder.WithWebSocketServer(o => o.WithUri(wssUri.ToString()));
                _logger.LogInformation("[MqttService] Using Secure WebSocket transport: {Uri}", wssUri);
                break;

            case BrokerProtocol.Tcp:
            default:
                optionsBuilder.WithTcpServer(_settings.BrokerHost, _settings.BrokerPort);
                _logger.LogInformation("[MqttService] Using TCP transport");
                break;
        }

        // Add credentials if configured
        if (!string.IsNullOrWhiteSpace(_settings.BrokerUsername))
        {
            optionsBuilder.WithCredentials(_settings.BrokerUsername, _settings.BrokerPassword ?? string.Empty);
            _logger.LogDebug("[MqttService] Using credentials for user: {Username}", _settings.BrokerUsername);
        }

        // Configure TLS if enabled
        if (_settings.BrokerUseTls)
        {
            _logger.LogInformation("[MqttService] TLS enabled for MQTT connection");
            optionsBuilder.WithTlsOptions(tls =>
            {
                tls.UseTls(true);

                if (_settings.BrokerAllowUntrustedCertificates)
                {
                    _logger.LogWarning("[MqttService] Allowing untrusted certificates - use only in development!");
                    tls.WithCertificateValidationHandler(_ => true);
                }
            });
        }

        var options = optionsBuilder.Build();

        try
        {
            await _mqttClient.ConnectAsync(options, cancellationToken);
            _logger.LogInformation("[MqttService] Connected to MQTT broker successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MqttService] Failed to connect to MQTT broker");
            throw;
        }
    }

    /// <summary>
    /// Called when successfully connected to the broker.
    /// Subscribes to transcription topics.
    /// </summary>
    private async Task OnConnectedAsync(MqttClientConnectedEventArgs e)
    {
        _logger.LogInformation("[MqttService] Connected event received, subscribing to topics");

        try
        {
            // Subscribe to all transcription topics using the configured pattern
            var subscribeOptions = new MqttClientSubscribeOptionsBuilder()
                .WithTopicFilter(_settings.TranscriptionTopicPattern, MqttQualityOfServiceLevel.AtMostOnce)
                .WithTopicFilter(SessionMappingTopicPattern, MqttQualityOfServiceLevel.AtLeastOnce)
                .Build();

            await _mqttClient.SubscribeAsync(subscribeOptions);

            _logger.LogInformation("[MqttService] Subscribed to topic patterns: {TranscriptionPattern}, {MappingPattern}",
                _settings.TranscriptionTopicPattern, SessionMappingTopicPattern);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MqttService] Failed to subscribe to topics");
        }
    }

    /// <summary>
    /// Called when disconnected from the broker.
    /// Will automatically reconnect via the main loop.
    /// </summary>
    private Task OnDisconnectedAsync(MqttClientDisconnectedEventArgs e)
    {
        if (e.Exception != null)
        {
            _logger.LogWarning(e.Exception, "[MqttService] Disconnected from MQTT broker: {Reason}",
                e.ReasonString);
        }
        else
        {
            _logger.LogInformation("[MqttService] Disconnected from MQTT broker: {Reason}",
                e.ReasonString);
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// Called when a message is received from the broker.
    /// Parses the topic and payload, then broadcasts to SignalR.
    /// </summary>
    private async Task OnMessageReceivedAsync(MqttApplicationMessageReceivedEventArgs e)
    {
        var topic = e.ApplicationMessage.Topic;

        // Handle session mapping messages
        if (topic.StartsWith("session/mapping/"))
        {
            HandleSessionMappingMessage(topic, e.ApplicationMessage.PayloadSegment);
            return;
        }

        // Parse topic: transcriber/out/{sessionId}/{channelId}/{partial|final}
        if (!TryParseTranscriptionTopic(topic, out var sessionId, out var channelId, out var isFinal))
        {
            _logger.LogDebug("[MqttService] Ignoring non-transcription topic: {Topic}", topic);
            return;
        }

        // Deserialize the payload
        var payload = Encoding.UTF8.GetString(e.ApplicationMessage.PayloadSegment);
        TranscriptionMessage? transcription;

        try
        {
            transcription = JsonSerializer.Deserialize<TranscriptionMessage>(payload, JsonOptions);
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "[MqttService] Failed to parse transcription message from topic {Topic}", topic);
            return;
        }

        if (transcription == null || string.IsNullOrWhiteSpace(transcription.Text))
        {
            return;
        }

        _logger.LogDebug("[MqttService] Received {Type} transcription for {Session}/{Channel}: {Text}",
            isFinal ? "final" : "partial",
            sessionId,
            channelId,
            transcription.Text.Length > 50 ? transcription.Text[..50] + "..." : transcription.Text);

        // Broadcast to SignalR group
        await BroadcastCaptionAsync(sessionId, channelId, transcription, isFinal);
    }

    /// <summary>
    /// Parses a transcription topic to extract session ID, channel ID, and whether it's final.
    /// </summary>
    private static bool TryParseTranscriptionTopic(
        string topic,
        out string sessionId,
        out string channelId,
        out bool isFinal)
    {
        sessionId = string.Empty;
        channelId = string.Empty;
        isFinal = false;

        // Expected format: transcriber/out/{sessionId}/{channelId}/{partial|final}
        if (!topic.StartsWith("transcriber/out/"))
        {
            return false;
        }

        var parts = topic.Split('/');
        if (parts.Length < 5)
        {
            return false;
        }

        sessionId = parts[2];
        channelId = parts[3];
        var type = parts[4];

        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(channelId))
        {
            return false;
        }

        isFinal = type.Equals("final", StringComparison.OrdinalIgnoreCase);
        return type.Equals("partial", StringComparison.OrdinalIgnoreCase) ||
               type.Equals("final", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Handles session mapping messages from TeamsMediaBot.
    /// Topic format: session/mapping/{sessionId}
    /// Empty payload means unmapping (bot left the meeting).
    /// </summary>
    private void HandleSessionMappingMessage(string topic, ArraySegment<byte> payloadSegment)
    {
        var parts = topic.Split('/');
        if (parts.Length < 3)
        {
            _logger.LogWarning("[MqttService] Invalid session mapping topic: {Topic}", topic);
            return;
        }

        var sessionId = parts[2];

        // Empty payload means unmapping
        if (payloadSegment.Count == 0)
        {
            _mappingCache.Remove(sessionId);
            return;
        }

        try
        {
            var payload = Encoding.UTF8.GetString(payloadSegment);
            var mapping = JsonSerializer.Deserialize<SessionMapping>(payload, JsonOptions);

            if (mapping != null)
            {
                _mappingCache.AddOrUpdate(mapping);
            }
        }
        catch (JsonException ex)
        {
            _logger.LogError(ex, "[MqttService] Failed to parse session mapping from topic {Topic}", topic);
        }
    }

    /// <summary>
    /// Broadcasts a caption to all clients in the corresponding SignalR group.
    /// </summary>
    private async Task BroadcastCaptionAsync(
        string sessionId,
        string channelId,
        TranscriptionMessage transcription,
        bool isFinal)
    {
        var groupName = CaptionsHub.GetGroupName(sessionId, channelId);
        var caption = CaptionPayload.FromTranscription(sessionId, channelId, transcription, isFinal);

        try
        {
            await _hubContext.Clients.Group(groupName).SendAsync("ReceiveCaption", caption);

            if (isFinal)
            {
                _logger.LogInformation("[MqttService] Broadcast final caption to group {Group}: {Text}",
                    groupName, transcription.Text);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MqttService] Failed to broadcast caption to group {Group}", groupName);
        }
    }

    /// <summary>
    /// Gracefully stops the service and disconnects from MQTT.
    /// </summary>
    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("[MqttService] Stopping MQTT transcription service");

        if (_mqttClient.IsConnected)
        {
            try
            {
                await _mqttClient.DisconnectAsync();
                _logger.LogInformation("[MqttService] Disconnected from MQTT broker");
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[MqttService] Error during MQTT disconnect");
            }
        }

        await base.StopAsync(cancellationToken);
    }

    /// <summary>
    /// Disposes of resources.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        if (_mqttClient.IsConnected)
        {
            try
            {
                await _mqttClient.DisconnectAsync();
            }
            catch
            {
                // Ignore errors during disposal
            }
        }

        _mqttClient.Dispose();
    }
}
