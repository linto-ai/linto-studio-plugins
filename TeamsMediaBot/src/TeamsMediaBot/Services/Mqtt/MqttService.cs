using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using MQTTnet;
using MQTTnet.Client;
using MQTTnet.Protocol;
using TeamsMediaBot.Models.Mqtt;

namespace TeamsMediaBot.Services.Mqtt
{
    /// <summary>
    /// MQTT service for communication with the Scheduler and TeamsAppService.
    /// </summary>
    public class MqttService : IMqttService, IDisposable
    {
        private readonly ILogger<MqttService> _logger;
        private readonly AppSettings _settings;
        private readonly IMqttClient _mqttClient;
        private readonly Timer _statusTimer;
        private readonly string _uniqueId;
        private readonly string _pubRoot;
        private int _activeBots;
        private bool _disposed;
        private readonly SemaphoreSlim _reconnectLock = new(1, 1);

        /// <inheritdoc/>
        public string UniqueId => _uniqueId;

        /// <inheritdoc/>
        public bool IsConnected => _mqttClient.IsConnected;

        /// <inheritdoc/>
        public event EventHandler<StartBotPayload>? OnStartBot;

        /// <inheritdoc/>
        public event EventHandler<StopBotPayload>? OnStopBot;

        public MqttService(ILogger<MqttService> logger, IOptions<AppSettings> settings)
        {
            _logger = logger;
            _settings = settings.Value;
            _uniqueId = $"teamsmediabot-{Guid.NewGuid()}";
            _pubRoot = $"botservice/out/{_uniqueId}";

            var factory = new MqttFactory();
            _mqttClient = factory.CreateMqttClient();
            _mqttClient.ApplicationMessageReceivedAsync += HandleMessageReceivedAsync;
            _mqttClient.DisconnectedAsync += HandleDisconnectedAsync;

            // Status publication timer (every 10 seconds)
            _statusTimer = new Timer(async _ => await PublishStatusAsync(_activeBots), null, Timeout.Infinite, Timeout.Infinite);

            _logger.LogInformation("[TeamsMediaBot] MQTT Service created with uniqueId: {UniqueId}", _uniqueId);
        }

        /// <inheritdoc/>
        public async Task ConnectAsync(CancellationToken cancellationToken = default)
        {
            _logger.LogInformation("[TeamsMediaBot] Connecting to MQTT broker at {Host}:{Port}",
                _settings.BrokerHost, _settings.BrokerPort);

            // Create Last Will Testament payload
            var lwtPayload = JsonSerializer.Serialize(new BotStatusPayload
            {
                UniqueId = _uniqueId,
                Online = false,
                ActiveBots = 0,
                On = DateTime.UtcNow.ToString("o"),
                MediaHostId = _settings.MediaHostId
            });

            var optionsBuilder = new MqttClientOptionsBuilder()
                .WithClientId(_uniqueId)
                .WithKeepAlivePeriod(TimeSpan.FromSeconds(_settings.BrokerKeepAlive))
                .WithWillTopic($"{_pubRoot}/status")
                .WithWillPayload(lwtPayload)
                .WithWillQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
                .WithWillRetain(true)
                .WithCleanSession(true);

            // Configure transport protocol (TCP, WebSocket, or SecureWebSocket)
            switch (_settings.BrokerProtocol)
            {
                case BrokerProtocol.WebSocket:
                    var wsUri = new Uri($"ws://{_settings.BrokerHost}:{_settings.BrokerPort}{_settings.BrokerWebSocketPath}");
                    optionsBuilder.WithConnectionUri(wsUri);
                    _logger.LogInformation("[TeamsMediaBot] Using WebSocket transport: {Uri}", wsUri);
                    break;

                case BrokerProtocol.SecureWebSocket:
                    var wssUri = new Uri($"wss://{_settings.BrokerHost}:{_settings.BrokerPort}{_settings.BrokerWebSocketPath}");
                    optionsBuilder.WithConnectionUri(wssUri);
                    _logger.LogInformation("[TeamsMediaBot] Using Secure WebSocket transport: {Uri}", wssUri);
                    break;

                case BrokerProtocol.Tcp:
                default:
                    optionsBuilder.WithTcpServer(_settings.BrokerHost, _settings.BrokerPort);
                    _logger.LogInformation("[TeamsMediaBot] Using TCP transport");
                    break;
            }

            // Add credentials if provided
            if (!string.IsNullOrEmpty(_settings.BrokerUsername))
            {
                optionsBuilder.WithCredentials(_settings.BrokerUsername, _settings.BrokerPassword ?? string.Empty);
            }

            // Configure TLS if enabled
            if (_settings.BrokerUseTls)
            {
                _logger.LogInformation("[TeamsMediaBot] TLS/SSL enabled for MQTT connection");
                optionsBuilder.WithTlsOptions(tls =>
                {
                    tls.UseTls(true);

                    // Allow untrusted certificates (self-signed) if configured
                    if (_settings.BrokerAllowUntrustedCertificates)
                    {
                        _logger.LogWarning("[TeamsMediaBot] Allowing untrusted certificates - use only in development!");
                        tls.WithCertificateValidationHandler(_ => true);
                    }
                });
            }

            var options = optionsBuilder.Build();

            try
            {
                await _mqttClient.ConnectAsync(options, cancellationToken);
                _logger.LogInformation("[TeamsMediaBot] Connected to MQTT broker");

                // Subscribe to command topics
                await SubscribeToCommandsAsync();

                // Start status publication timer
                _statusTimer.Change(TimeSpan.Zero, TimeSpan.FromSeconds(10));

                _logger.LogInformation("[TeamsMediaBot] MQTT Service fully initialized");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Failed to connect to MQTT broker");
                throw;
            }
        }

        /// <inheritdoc/>
        public async Task DisconnectAsync()
        {
            _logger.LogInformation("[TeamsMediaBot] Disconnecting from MQTT broker");

            // Stop status timer
            _statusTimer.Change(Timeout.Infinite, Timeout.Infinite);

            // Publish offline status
            try
            {
                await PublishStatusAsync(0, online: false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[TeamsMediaBot] Failed to publish offline status");
            }

            try
            {
                await _mqttClient.DisconnectAsync();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[TeamsMediaBot] Error during MQTT disconnect");
            }
        }

        /// <inheritdoc/>
        public async Task PublishStatusAsync(int activeBots)
        {
            await PublishStatusAsync(activeBots, online: true);
        }

        private async Task PublishStatusAsync(int activeBots, bool online)
        {
            if (!_mqttClient.IsConnected)
            {
                _logger.LogWarning("[TeamsMediaBot] Cannot publish status: not connected to MQTT broker");
                return;
            }

            _activeBots = activeBots;

            var status = new BotStatusPayload
            {
                UniqueId = _uniqueId,
                Online = online,
                ActiveBots = activeBots,
                Capabilities = new List<string> { "teams" },
                On = DateTime.UtcNow.ToString("o"),
                MediaHostId = _settings.MediaHostId
            };

            var payload = JsonSerializer.Serialize(status);
            var message = new MqttApplicationMessageBuilder()
                .WithTopic($"{_pubRoot}/status")
                .WithPayload(payload)
                .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
                .WithRetainFlag(true)
                .Build();

            try
            {
                await _mqttClient.PublishAsync(message);
                _logger.LogDebug("[TeamsMediaBot] Published status: activeBots={ActiveBots}, online={Online}", activeBots, online);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Failed to publish status");
            }
        }

        /// <inheritdoc/>
        public async Task PublishMeetingJoinedAsync(string sessionId, string channelId, string threadId, List<string>? translations = null)
        {
            if (!_mqttClient.IsConnected)
            {
                _logger.LogWarning("[TeamsMediaBot] Cannot publish meeting-joined: not connected to MQTT broker");
                return;
            }

            var payload = new MeetingJoinedPayload
            {
                SessionId = sessionId,
                ChannelId = channelId,
                ThreadId = threadId,
                JoinedAt = DateTime.UtcNow.ToString("o"),
                Translations = translations
            };

            var jsonPayload = JsonSerializer.Serialize(payload);
            var message = new MqttApplicationMessageBuilder()
                .WithTopic("teamsappservice/in/meeting-joined")
                .WithPayload(jsonPayload)
                .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
                .WithRetainFlag(false)
                .Build();

            try
            {
                await _mqttClient.PublishAsync(message);
                _logger.LogInformation("[TeamsMediaBot] Published meeting-joined for session {SessionId}, channel {ChannelId}, threadId {ThreadId}",
                    sessionId, channelId, threadId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Failed to publish meeting-joined");
            }
        }

        /// <inheritdoc/>
        public async Task PublishMeetingLeftAsync(string sessionId, string channelId, string threadId)
        {
            if (!_mqttClient.IsConnected)
            {
                _logger.LogWarning("[TeamsMediaBot] Cannot publish meeting-left: not connected to MQTT broker");
                return;
            }

            var payload = new MeetingLeftPayload
            {
                SessionId = sessionId,
                ChannelId = channelId,
                ThreadId = threadId
            };

            var jsonPayload = JsonSerializer.Serialize(payload);
            var message = new MqttApplicationMessageBuilder()
                .WithTopic("teamsappservice/in/meeting-left")
                .WithPayload(jsonPayload)
                .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
                .WithRetainFlag(false)
                .Build();

            try
            {
                await _mqttClient.PublishAsync(message);
                _logger.LogInformation("[TeamsMediaBot] Published meeting-left for session {SessionId}, channel {ChannelId}, threadId {ThreadId}",
                    sessionId, channelId, threadId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Failed to publish meeting-left");
            }
        }

        /// <inheritdoc/>
        public async Task PublishSessionMappingAsync(
            string sessionId,
            string channelId,
            string threadId,
            string? meetingUrl,
            bool enableDisplaySub,
            CancellationToken cancellationToken = default)
        {
            if (!_mqttClient.IsConnected)
            {
                _logger.LogWarning("[TeamsMediaBot] Cannot publish session mapping: not connected to MQTT broker");
                return;
            }

            var payload = new SessionMappingPayload
            {
                SessionId = sessionId,
                ChannelId = channelId,
                ThreadId = threadId,
                MeetingUrl = meetingUrl,
                BotInstanceId = _uniqueId,
                Timestamp = DateTime.UtcNow,
                EnableDisplaySub = enableDisplaySub
            };

            var topic = $"session/mapping/{sessionId}";
            var message = new MqttApplicationMessageBuilder()
                .WithTopic(topic)
                .WithPayload(JsonSerializer.Serialize(payload))
                .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
                .WithRetainFlag(true) // Retain so new subscribers get the mapping
                .Build();

            try
            {
                await _mqttClient.PublishAsync(message, cancellationToken);
                _logger.LogInformation("[TeamsMediaBot] Published session mapping: ThreadId={ThreadId} -> Session={SessionId}, Channel={ChannelId}",
                    threadId, sessionId, channelId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Failed to publish session mapping for session {SessionId}", sessionId);
            }
        }

        /// <inheritdoc/>
        public async Task PublishSessionUnmappingAsync(string sessionId, CancellationToken cancellationToken = default)
        {
            if (!_mqttClient.IsConnected)
            {
                _logger.LogWarning("[TeamsMediaBot] Cannot publish session unmapping: not connected to MQTT broker");
                return;
            }

            // Publish empty payload with retain flag to clear the retained message
            var topic = $"session/mapping/{sessionId}";
            var message = new MqttApplicationMessageBuilder()
                .WithTopic(topic)
                .WithPayload(Array.Empty<byte>())
                .WithRetainFlag(true)
                .Build();

            try
            {
                await _mqttClient.PublishAsync(message, cancellationToken);
                _logger.LogInformation("[TeamsMediaBot] Published session unmapping for session {SessionId}", sessionId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Failed to publish session unmapping for session {SessionId}", sessionId);
            }
        }

        private async Task SubscribeToCommandsAsync()
        {
            // Subscribe to general command topics and specific instance topics
            var topics = new[]
            {
                "botservice/in/#",
                $"botservice-{_uniqueId}/in/#"
            };

            _logger.LogInformation("[TeamsMediaBot] Subscribing to command topics");

            var subscribeOptions = new MqttClientSubscribeOptionsBuilder();
            foreach (var topic in topics)
            {
                subscribeOptions.WithTopicFilter(topic, MqttQualityOfServiceLevel.AtLeastOnce);
            }

            await _mqttClient.SubscribeAsync(subscribeOptions.Build());
        }

        private Task HandleMessageReceivedAsync(MqttApplicationMessageReceivedEventArgs e)
        {
            var topic = e.ApplicationMessage.Topic;
            var payload = Encoding.UTF8.GetString(e.ApplicationMessage.PayloadSegment);

            _logger.LogDebug("[TeamsMediaBot] Received message on topic: {Topic}", topic);

            try
            {
                // Handle startbot command
                if (topic.EndsWith("/startbot"))
                {
                    var startBotPayload = JsonSerializer.Deserialize<StartBotPayload>(payload);
                    if (startBotPayload != null)
                    {
                        _logger.LogInformation("[TeamsMediaBot] Received startbot command for session {SessionId}, channel {ChannelId}",
                            startBotPayload.Session?.Id, startBotPayload.Channel?.Id);
                        OnStartBot?.Invoke(this, startBotPayload);
                    }
                }
                // Handle stopbot command
                else if (topic.EndsWith("/stopbot"))
                {
                    var stopBotPayload = JsonSerializer.Deserialize<StopBotPayload>(payload);
                    if (stopBotPayload != null)
                    {
                        _logger.LogInformation("[TeamsMediaBot] Received stopbot command for session {SessionId}, channel {ChannelId}",
                            stopBotPayload.SessionId, stopBotPayload.ChannelId);
                        OnStopBot?.Invoke(this, stopBotPayload);
                    }
                }
            }
            catch (JsonException ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Failed to parse message on topic {Topic}", topic);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Error handling message on topic {Topic}", topic);
            }

            return Task.CompletedTask;
        }

        private async Task HandleDisconnectedAsync(MqttClientDisconnectedEventArgs e)
        {
            _logger.LogWarning("[TeamsMediaBot] Disconnected from MQTT broker: {Reason}", e.ReasonString);

            if (_disposed) return;

            // Prevent multiple concurrent reconnection loops
            if (!_reconnectLock.Wait(0))
            {
                _logger.LogDebug("[TeamsMediaBot] Reconnection already in progress, skipping");
                return;
            }

            try
            {
                // Reconnection loop with exponential backoff
                var baseDelay = 2000;  // Start at 2 seconds
                var maxDelay = 60000;  // Max 60 seconds between attempts
                var attempt = 0;

                while (!_disposed && !_mqttClient.IsConnected)
                {
                    attempt++;

                    // Calculate delay with exponential backoff + jitter
                    var exponentialDelay = Math.Min(baseDelay * (int)Math.Pow(2, attempt - 1), maxDelay);
                    var jitter = Random.Shared.Next(0, 1000);
                    var delay = exponentialDelay + jitter;

                    _logger.LogInformation("[TeamsMediaBot] Reconnection attempt {Attempt} in {Delay}ms", attempt, delay);

                    await Task.Delay(delay);

                    if (_disposed) return;

                    // Re-check after delay in case another path reconnected
                    if (_mqttClient.IsConnected)
                    {
                        _logger.LogInformation("[TeamsMediaBot] Already reconnected, stopping reconnection loop");
                        return;
                    }

                    try
                    {
                        await ConnectAsync();
                        _logger.LogInformation("[TeamsMediaBot] Successfully reconnected after {Attempt} attempt(s)", attempt);
                        return;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "[TeamsMediaBot] Reconnection attempt {Attempt} failed", attempt);
                    }
                }
            }
            finally
            {
                _reconnectLock.Release();
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            _statusTimer.Dispose();
            _reconnectLock.Dispose();
            _mqttClient.Dispose();
        }
    }
}
