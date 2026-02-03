using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using TeamsMediaBot.Bot;
using TeamsMediaBot.Models;
using TeamsMediaBot.Models.Mqtt;
using TeamsMediaBot.Services.Mqtt;
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
            IOptions<AppSettings> settings)
        {
            _logger = logger;
            _loggerFactory = loggerFactory;
            _mqttService = mqttService;
            _botService = botService;
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

        /// <inheritdoc/>
        public ManagedBot? GetBotByThreadId(string threadId)
        {
            return _activeBots.Values.FirstOrDefault(b => b.ThreadId == threadId);
        }

        /// <inheritdoc/>
        public IEnumerable<ManagedBot> GetAllBots()
        {
            return _activeBots.Values.ToList();
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

        private async Task StartBotAsync(StartBotPayload payload)
        {
            var key = $"{payload.Session.Id}_{payload.Channel.Id}";

            _logger.LogInformation("[Orchestrator] Starting bot for session {SessionId}", payload.Session.Id);
            _logger.LogDebug("[Orchestrator] Channel: {ChannelId}, Meeting: {Url}", payload.Channel.Id, payload.Address);

            // Check if bot already exists
            if (_activeBots.ContainsKey(key))
            {
                _logger.LogWarning("[Orchestrator] Bot already exists for key {Key}, ignoring startbot command", key);
                return;
            }

            // Create WebSocket connection to Transcriber
            var webSocket = new TranscriberWebSocket(_loggerFactory.CreateLogger<TranscriberWebSocket>());

            // Wire up WebSocket events
            webSocket.OnClosed += async (s, e) =>
            {
                _logger.LogWarning("[Orchestrator] WebSocket closed for {Key}", key);
                await StopBotAsync(payload.Session.Id, payload.Channel.Id);
            };

            webSocket.OnError += async (s, ex) =>
            {
                _logger.LogError(ex, "[Orchestrator] WebSocket error for {Key}", key);
                await StopBotAsync(payload.Session.Id, payload.Channel.Id);
            };

            // Create managed bot
            var managedBot = new ManagedBot(payload, webSocket, _logger);

            // Build WebSocket URL, optionally replacing host
            var websocketUrl = payload.WebsocketUrl;
            if (!string.IsNullOrEmpty(_settings.TranscriberHost))
            {
                var uri = new Uri(websocketUrl);
                var builder = new UriBuilder(uri) { Host = _settings.TranscriberHost };
                websocketUrl = builder.ToString();
                _logger.LogDebug("[Orchestrator] WebSocket host override to {Host}", _settings.TranscriberHost);
            }

            // Connect to Transcriber WebSocket
            _logger.LogDebug("[Orchestrator] Connecting to Transcriber...");
            var connected = await webSocket.ConnectAsync(websocketUrl);
            if (!connected)
            {
                _logger.LogError("[Orchestrator] WebSocket connection failed for {Key}", key);
                managedBot.Dispose();
                return;
            }

            // Join Teams meeting
            try
            {
                var joinCallBody = new JoinCallBody
                {
                    JoinUrl = payload.Address
                    // DisplayName removed - causes error 580 when bot admitted from lobby
                };

                var call = await _botService.JoinCallAsync(joinCallBody);
                var threadId = call.Resource.ChatInfo.ThreadId;
                managedBot.ThreadId = threadId;

                _logger.LogDebug("[Orchestrator] Joined meeting, ThreadId: {ThreadId}", threadId);
                try
                {
                    await _mqttService.PublishSessionMappingAsync(
                        payload.Session.Id,
                        payload.Channel.Id,
                        threadId,
                        payload.Address,
                        enableDisplaySub: false);
                }
                catch (Exception mappingEx)
                {
                    _logger.LogWarning(mappingEx, "[Orchestrator] Failed to publish session mapping");
                }

                // Wait for CallHandler to be created
                await WaitForCallHandlerAsync(threadId);

                // Get the CallHandler
                if (_botService.CallHandlers.TryGetValue(threadId, out var callHandler))
                {
                    managedBot.CallHandler = callHandler;
                    managedBot.WireAudioHandler();
                    managedBot.WireSpeakerHandler();
                }
                else
                {
                    _logger.LogError("[Orchestrator] CallHandler not found for {ThreadId}", threadId);
                    await webSocket.CloseAsync();
                    managedBot.Dispose();
                    return;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[Orchestrator] Teams join failed");
                await webSocket.CloseAsync();
                managedBot.Dispose();
                return;
            }

            // Add to active bots
            if (!_activeBots.TryAdd(key, managedBot))
            {
                _logger.LogWarning("[Orchestrator] Failed to add bot to dictionary");
                managedBot.Dispose();
                return;
            }

            // Publish meeting-joined event to TeamsAppService
            await _mqttService.PublishMeetingJoinedAsync(payload.Session.Id, payload.Channel.Id, managedBot.ThreadId!, payload.Channel.Translations);
            await _mqttService.PublishStatusAsync(_activeBots.Count);

            _logger.LogInformation("[Orchestrator] Bot started for {Key}, active: {Count}", key, _activeBots.Count);
        }

        private async Task WaitForCallHandlerAsync(string threadId, int maxWaitMs = 10000)
        {
            var startTime = DateTime.UtcNow;

            while ((DateTime.UtcNow - startTime).TotalMilliseconds < maxWaitMs)
            {
                if (_botService.CallHandlers.ContainsKey(threadId))
                {
                    _logger.LogDebug("[Orchestrator] CallHandler ready in {Elapsed}ms", (DateTime.UtcNow - startTime).TotalMilliseconds);
                    return;
                }
                await Task.Delay(100);
            }

            _logger.LogWarning("[Orchestrator] CallHandler timeout for {ThreadId}", threadId);
        }

        private async Task StopBotAsync(string sessionId, string channelId)
        {
            var key = $"{sessionId}_{channelId}";
            _logger.LogInformation("[Orchestrator] Stopping bot {Key}", key);

            if (!_activeBots.TryRemove(key, out var managedBot))
            {
                _logger.LogWarning("[Orchestrator] Bot not found: {Key}", key);
                return;
            }

            // Publish meeting-left event
            if (!string.IsNullOrEmpty(managedBot.ThreadId))
            {
                try { await _mqttService.PublishMeetingLeftAsync(sessionId, channelId, managedBot.ThreadId); }
                catch (Exception ex) { _logger.LogWarning(ex, "[Orchestrator] Error publishing meeting-left"); }
            }

            // Publish session unmapping
            try { await _mqttService.PublishSessionUnmappingAsync(sessionId); }
            catch (Exception ex) { _logger.LogWarning(ex, "[Orchestrator] Error publishing unmapping"); }

            // Close WebSocket
            try { await managedBot.WebSocket.CloseAsync(); }
            catch (Exception ex) { _logger.LogWarning(ex, "[Orchestrator] Error closing WebSocket"); }

            // Leave Teams meeting
            if (!string.IsNullOrEmpty(managedBot.ThreadId))
            {
                try { await _botService.EndCallByThreadIdAsync(managedBot.ThreadId); }
                catch (Exception ex) { _logger.LogWarning(ex, "[Orchestrator] Error ending Teams call"); }
            }

            managedBot.Dispose();
            await _mqttService.PublishStatusAsync(_activeBots.Count);

            _logger.LogInformation("[Orchestrator] Bot stopped {Key}, remaining: {Count}", key, _activeBots.Count);
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
