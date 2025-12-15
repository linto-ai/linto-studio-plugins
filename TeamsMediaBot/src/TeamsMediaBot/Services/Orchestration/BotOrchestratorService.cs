using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using TeamsMediaBot.Bot;
using TeamsMediaBot.Models;
using TeamsMediaBot.Models.Mqtt;
using TeamsMediaBot.Services.Mqtt;
using TeamsMediaBot.Services.Transcription;
using TeamsMediaBot.Services.WebSocket;

namespace TeamsMediaBot.Services.Orchestration
{
    /// <summary>
    /// Orchestrates bot instances in response to MQTT commands from the Scheduler.
    /// </summary>
    public class BotOrchestratorService : IBotOrchestratorService, IDisposable
    {
        private readonly ILogger<BotOrchestratorService> _logger;
        private readonly ILoggerFactory _loggerFactory;
        private readonly IMqttService _mqttService;
        private readonly IBotService _botService;
        private readonly ITranscriptionHandler _transcriptionHandler;
        private readonly AppSettings _settings;
        private readonly ConcurrentDictionary<string, ManagedBot> _activeBots;
        private bool _disposed;

        /// <inheritdoc/>
        public int ActiveBotCount => _activeBots.Count;

        public BotOrchestratorService(
            ILogger<BotOrchestratorService> logger,
            ILoggerFactory loggerFactory,
            IMqttService mqttService,
            IBotService botService,
            ITranscriptionHandler transcriptionHandler,
            IOptions<AppSettings> settings)
        {
            _logger = logger;
            _loggerFactory = loggerFactory;
            _mqttService = mqttService;
            _botService = botService;
            _transcriptionHandler = transcriptionHandler;
            _settings = settings.Value;
            _activeBots = new ConcurrentDictionary<string, ManagedBot>();
        }

        /// <inheritdoc/>
        public async Task InitializeAsync(CancellationToken cancellationToken = default)
        {
            _logger.LogInformation("[TeamsMediaBot] Initializing Bot Orchestrator Service");

            // Subscribe to MQTT events
            _mqttService.OnStartBot += HandleStartBot;
            _mqttService.OnStopBot += HandleStopBot;
            _mqttService.OnTranscription += HandleTranscription;

            // Connect to MQTT
            await _mqttService.ConnectAsync(cancellationToken);

            _logger.LogInformation("[TeamsMediaBot] Bot Orchestrator Service initialized");
        }

        /// <inheritdoc/>
        public async Task ShutdownAsync()
        {
            _logger.LogInformation("[TeamsMediaBot] Shutting down Bot Orchestrator Service");

            // Stop all active bots
            foreach (var bot in _activeBots.Values.ToList())
            {
                await StopBotAsync(bot.SessionId, bot.ChannelId);
            }

            // Unsubscribe from MQTT events
            _mqttService.OnStartBot -= HandleStartBot;
            _mqttService.OnStopBot -= HandleStopBot;
            _mqttService.OnTranscription -= HandleTranscription;

            // Disconnect from MQTT
            await _mqttService.DisconnectAsync();

            _logger.LogInformation("[TeamsMediaBot] Bot Orchestrator Service shut down");
        }

        /// <inheritdoc/>
        public ManagedBot? GetBot(string sessionId, string channelId)
        {
            var key = $"{sessionId}_{channelId}";
            _activeBots.TryGetValue(key, out var bot);
            return bot;
        }

        private async void HandleStartBot(object? sender, StartBotPayload payload)
        {
            try
            {
                await StartBotAsync(payload);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Error handling startbot command for session {SessionId}",
                    payload.Session?.Id);
            }
        }

        private async void HandleStopBot(object? sender, StopBotPayload payload)
        {
            try
            {
                await StopBotAsync(payload.SessionId, payload.ChannelId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Error handling stopbot command for session {SessionId}",
                    payload.SessionId);
            }
        }

        private void HandleTranscription(object? sender, (string sessionId, string channelId, TranscriptionMessage message, bool isFinal) args)
        {
            var key = $"{args.sessionId}_{args.channelId}";
            if (_activeBots.TryGetValue(key, out var bot) && bot.EnableDisplaySub)
            {
                _transcriptionHandler.HandleTranscription(bot, args.message, args.isFinal);
            }
        }

        private async Task StartBotAsync(StartBotPayload payload)
        {
            var key = $"{payload.Session.Id}_{payload.Channel.Id}";

            _logger.LogInformation("[TeamsMediaBot] Starting bot for session {SessionId}, channel {ChannelId}",
                payload.Session.Id, payload.Channel.Id);

            // Check if bot already exists
            if (_activeBots.ContainsKey(key))
            {
                _logger.LogWarning("[TeamsMediaBot] Bot already exists for key {Key}", key);
                return;
            }

            // Create WebSocket connection to Transcriber
            var webSocket = new TranscriberWebSocket(_loggerFactory.CreateLogger<TranscriberWebSocket>());

            // Wire up WebSocket events
            webSocket.OnClosed += async (s, e) =>
            {
                _logger.LogWarning("[TeamsMediaBot] WebSocket closed for bot {Key}, stopping bot", key);
                await StopBotAsync(payload.Session.Id, payload.Channel.Id);
            };

            webSocket.OnError += async (s, ex) =>
            {
                _logger.LogError(ex, "[TeamsMediaBot] WebSocket error for bot {Key}", key);
                await StopBotAsync(payload.Session.Id, payload.Channel.Id);
            };

            // Create managed bot
            var managedBot = new ManagedBot(payload, webSocket, _logger);

            // Build WebSocket URL, optionally replacing host
            var websocketUrl = payload.WebsocketUrl;
            if (!string.IsNullOrEmpty(_settings.TranscriberHost))
            {
                var uri = new Uri(websocketUrl);
                var builder = new UriBuilder(uri)
                {
                    Host = _settings.TranscriberHost
                };
                websocketUrl = builder.ToString();
                _logger.LogInformation("[TeamsMediaBot] Overriding WebSocket host to {Host}", _settings.TranscriberHost);
            }

            // Connect to Transcriber WebSocket
            var connected = await webSocket.ConnectAsync(websocketUrl);
            if (!connected)
            {
                _logger.LogError("[TeamsMediaBot] Failed to connect to Transcriber WebSocket for bot {Key}", key);
                managedBot.Dispose();
                return;
            }

            // Join Teams meeting
            try
            {
                var joinCallBody = new JoinCallBody
                {
                    JoinUrl = payload.Address,
                    DisplayName = _settings.BotDisplayName
                };

                var call = await _botService.JoinCallAsync(joinCallBody);
                var threadId = call.Resource.ChatInfo.ThreadId;
                managedBot.ThreadId = threadId;

                _logger.LogInformation("[TeamsMediaBot] Joined Teams meeting, threadId: {ThreadId}", threadId);

                // Wait for CallHandler to be created
                await WaitForCallHandlerAsync(threadId);

                // Get the CallHandler
                if (_botService.CallHandlers.TryGetValue(threadId, out var callHandler))
                {
                    managedBot.CallHandler = callHandler;

                    // Wire audio handler
                    managedBot.WireAudioHandler();
                }
                else
                {
                    _logger.LogError("[TeamsMediaBot] CallHandler not found for threadId {ThreadId}", threadId);
                    await webSocket.CloseAsync();
                    managedBot.Dispose();
                    return;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Failed to join Teams meeting");
                await webSocket.CloseAsync();
                managedBot.Dispose();
                return;
            }

            // Add to active bots
            if (!_activeBots.TryAdd(key, managedBot))
            {
                _logger.LogWarning("[TeamsMediaBot] Failed to add bot to active bots dictionary");
                managedBot.Dispose();
                return;
            }

            // Subscribe to transcription topics
            await _mqttService.SubscribeToTranscriptionsAsync(payload.Session.Id, payload.Channel.Id);

            // Update status
            await _mqttService.PublishStatusAsync(_activeBots.Count);

            _logger.LogInformation("[TeamsMediaBot] Bot started successfully for key {Key}", key);
        }

        private async Task WaitForCallHandlerAsync(string threadId, int maxWaitMs = 10000)
        {
            var startTime = DateTime.UtcNow;
            while ((DateTime.UtcNow - startTime).TotalMilliseconds < maxWaitMs)
            {
                if (_botService.CallHandlers.ContainsKey(threadId))
                {
                    return;
                }
                await Task.Delay(100);
            }

            _logger.LogWarning("[TeamsMediaBot] Timeout waiting for CallHandler for threadId {ThreadId}", threadId);
        }

        private async Task StopBotAsync(string sessionId, string channelId)
        {
            var key = $"{sessionId}_{channelId}";

            _logger.LogInformation("[TeamsMediaBot] Stopping bot for session {SessionId}, channel {ChannelId}",
                sessionId, channelId);

            if (!_activeBots.TryRemove(key, out var managedBot))
            {
                _logger.LogWarning("[TeamsMediaBot] Bot not found for key {Key}", key);
                return;
            }

            // Unsubscribe from transcription topics
            try
            {
                await _mqttService.UnsubscribeFromTranscriptionsAsync(sessionId, channelId);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[TeamsMediaBot] Error unsubscribing from transcription topics");
            }

            // Close WebSocket
            try
            {
                await managedBot.WebSocket.CloseAsync();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[TeamsMediaBot] Error closing WebSocket");
            }

            // Leave Teams meeting
            if (!string.IsNullOrEmpty(managedBot.ThreadId))
            {
                try
                {
                    await _botService.EndCallByThreadIdAsync(managedBot.ThreadId);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[TeamsMediaBot] Error ending Teams call");
                }
            }

            // Dispose managed bot
            managedBot.Dispose();

            // Update status
            await _mqttService.PublishStatusAsync(_activeBots.Count);

            _logger.LogInformation("[TeamsMediaBot] Bot stopped successfully for key {Key}", key);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            foreach (var bot in _activeBots.Values)
            {
                bot.Dispose();
            }
            _activeBots.Clear();
        }
    }
}
