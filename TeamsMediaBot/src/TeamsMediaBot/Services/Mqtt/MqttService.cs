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
    /// MQTT service for communication with the Scheduler and Transcriber.
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

        /// <inheritdoc/>
        public string UniqueId => _uniqueId;

        /// <inheritdoc/>
        public bool IsConnected => _mqttClient.IsConnected;

        /// <inheritdoc/>
        public event EventHandler<StartBotPayload>? OnStartBot;

        /// <inheritdoc/>
        public event EventHandler<StopBotPayload>? OnStopBot;

        /// <inheritdoc/>
        public event EventHandler<(string sessionId, string channelId, TranscriptionMessage message, bool isFinal)>? OnTranscription;

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
                On = DateTime.UtcNow.ToString("o")
            });

            var optionsBuilder = new MqttClientOptionsBuilder()
                .WithClientId(_uniqueId)
                .WithTcpServer(_settings.BrokerHost, _settings.BrokerPort)
                .WithKeepAlivePeriod(TimeSpan.FromSeconds(_settings.BrokerKeepAlive))
                .WithWillTopic($"{_pubRoot}/status")
                .WithWillPayload(lwtPayload)
                .WithWillQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
                .WithWillRetain(true)
                .WithCleanSession(true);

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
                On = DateTime.UtcNow.ToString("o")
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
        public async Task SubscribeToTranscriptionsAsync(string sessionId, string channelId)
        {
            var partialTopic = $"transcriber/out/{sessionId}/{channelId}/partial";
            var finalTopic = $"transcriber/out/{sessionId}/{channelId}/final";

            _logger.LogInformation("[TeamsMediaBot] Subscribing to transcription topics for session {SessionId}, channel {ChannelId}",
                sessionId, channelId);

            var subscribeOptions = new MqttClientSubscribeOptionsBuilder()
                .WithTopicFilter(partialTopic, MqttQualityOfServiceLevel.AtMostOnce)
                .WithTopicFilter(finalTopic, MqttQualityOfServiceLevel.AtMostOnce)
                .Build();

            await _mqttClient.SubscribeAsync(subscribeOptions);
        }

        /// <inheritdoc/>
        public async Task UnsubscribeFromTranscriptionsAsync(string sessionId, string channelId)
        {
            var partialTopic = $"transcriber/out/{sessionId}/{channelId}/partial";
            var finalTopic = $"transcriber/out/{sessionId}/{channelId}/final";

            _logger.LogInformation("[TeamsMediaBot] Unsubscribing from transcription topics for session {SessionId}, channel {ChannelId}",
                sessionId, channelId);

            var unsubscribeOptions = new MqttClientUnsubscribeOptionsBuilder()
                .WithTopicFilter(partialTopic)
                .WithTopicFilter(finalTopic)
                .Build();

            await _mqttClient.UnsubscribeAsync(unsubscribeOptions);
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
                // Handle transcription messages
                else if (topic.StartsWith("transcriber/out/"))
                {
                    var parts = topic.Split('/');
                    if (parts.Length >= 5)
                    {
                        var sessionId = parts[2];
                        var channelId = parts[3];
                        var type = parts[4];
                        var isFinal = type == "final";

                        var transcription = JsonSerializer.Deserialize<TranscriptionMessage>(payload);
                        if (transcription != null)
                        {
                            _logger.LogDebug("[TeamsMediaBot] Received {Type} transcription for session {SessionId}: {Text}",
                                type, sessionId, transcription.Text);
                            OnTranscription?.Invoke(this, (sessionId, channelId, transcription, isFinal));
                        }
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

            // Attempt to reconnect with random delay (2-5 seconds)
            var delay = Random.Shared.Next(2000, 5000);
            _logger.LogInformation("[TeamsMediaBot] Attempting to reconnect in {Delay}ms", delay);

            await Task.Delay(delay);

            try
            {
                if (!_disposed && !_mqttClient.IsConnected)
                {
                    await ConnectAsync();
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Reconnection attempt failed");
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            _statusTimer.Dispose();
            _mqttClient.Dispose();
        }
    }
}
