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

            _logger.LogInformation("[Orchestrator] ========================================");
            _logger.LogInformation("[Orchestrator] === STARTING BOT ===");
            _logger.LogInformation("[Orchestrator] Session: {SessionId}", payload.Session.Id);
            _logger.LogInformation("[Orchestrator] Channel: {ChannelId}", payload.Channel.Id);
            _logger.LogInformation("[Orchestrator] Meeting URL: {Url}", payload.Address);
            _logger.LogInformation("[Orchestrator] WebSocket URL: {WsUrl}", payload.WebsocketUrl);
            _logger.LogInformation("[Orchestrator] ========================================");

            // Check if bot already exists
            if (_activeBots.ContainsKey(key))
            {
                _logger.LogWarning("[Orchestrator] Bot already exists for key {Key}, ignoring startbot command", key);
                return;
            }

            // Create WebSocket connection to Transcriber
            _logger.LogInformation("[Orchestrator] Step 1: Creating WebSocket client...");
            var webSocket = new TranscriberWebSocket(_loggerFactory.CreateLogger<TranscriberWebSocket>());

            // Wire up WebSocket events
            webSocket.OnClosed += async (s, e) =>
            {
                _logger.LogWarning("[Orchestrator] === WEBSOCKET CLOSED EVENT ===");
                _logger.LogWarning("[Orchestrator] Bot {Key} WebSocket closed, triggering bot stop", key);
                await StopBotAsync(payload.Session.Id, payload.Channel.Id);
            };

            webSocket.OnError += async (s, ex) =>
            {
                _logger.LogError("[Orchestrator] === WEBSOCKET ERROR EVENT ===");
                _logger.LogError(ex, "[Orchestrator] Bot {Key} WebSocket error: {Message}", key, ex.Message);
                await StopBotAsync(payload.Session.Id, payload.Channel.Id);
            };

            // Create managed bot
            var managedBot = new ManagedBot(payload, webSocket, _logger);

            // Build WebSocket URL, optionally replacing host
            var websocketUrl = payload.WebsocketUrl;
            if (!string.IsNullOrEmpty(_settings.TranscriberHost))
            {
                var originalUrl = websocketUrl;
                var uri = new Uri(websocketUrl);
                var builder = new UriBuilder(uri)
                {
                    Host = _settings.TranscriberHost
                };
                websocketUrl = builder.ToString();
                _logger.LogInformation("[Orchestrator] WebSocket host override: {Original} -> {New}",
                    originalUrl, websocketUrl);
            }

            // Connect to Transcriber WebSocket
            _logger.LogInformation("[Orchestrator] Step 2: Connecting to Transcriber WebSocket...");
            var connected = await webSocket.ConnectAsync(websocketUrl);
            if (!connected)
            {
                _logger.LogError("[Orchestrator] === WEBSOCKET CONNECTION FAILED ===");
                _logger.LogError("[Orchestrator] Could not connect to Transcriber at {Url}", websocketUrl);
                _logger.LogError("[Orchestrator] Bot startup aborted for {Key}", key);
                managedBot.Dispose();
                return;
            }
            _logger.LogInformation("[Orchestrator] Step 2 completed: WebSocket connected successfully");

            // Join Teams meeting
            _logger.LogInformation("[Orchestrator] Step 3: Joining Teams meeting...");
            try
            {
                var joinCallBody = new JoinCallBody
                {
                    JoinUrl = payload.Address,
                    DisplayName = _settings.BotDisplayName
                };
                _logger.LogInformation("[Orchestrator] Calling BotService.JoinCallAsync with display name: {Name}",
                    _settings.BotDisplayName);

                var call = await _botService.JoinCallAsync(joinCallBody);
                var threadId = call.Resource.ChatInfo.ThreadId;
                managedBot.ThreadId = threadId;

                _logger.LogInformation("[Orchestrator] Step 3 completed: Joined Teams meeting");
                _logger.LogInformation("[Orchestrator] ThreadId: {ThreadId}", threadId);
                _logger.LogInformation("[Orchestrator] Call ID: {CallId}", call.Id);

                // Publish session mapping to MQTT for other services (LiveCaptionsServer)
                _logger.LogInformation("[Orchestrator] Step 4: Publishing session mapping to MQTT...");
                try
                {
                    await _mqttService.PublishSessionMappingAsync(
                        payload.Session.Id,
                        payload.Channel.Id,
                        threadId,
                        payload.Address,
                        enableDisplaySub: false);
                    _logger.LogInformation("[Orchestrator] Step 4 completed: Session mapping published");
                }
                catch (Exception mappingEx)
                {
                    _logger.LogWarning(mappingEx, "[Orchestrator] Failed to publish session mapping (non-fatal)");
                }

                // Wait for CallHandler to be created
                _logger.LogInformation("[Orchestrator] Step 5: Waiting for CallHandler (max 10s)...");
                await WaitForCallHandlerAsync(threadId);

                // Get the CallHandler
                if (_botService.CallHandlers.TryGetValue(threadId, out var callHandler))
                {
                    managedBot.CallHandler = callHandler;
                    _logger.LogInformation("[Orchestrator] Step 5 completed: CallHandler obtained");

                    // Wire audio handler
                    _logger.LogInformation("[Orchestrator] Step 6: Wiring audio handler...");
                    managedBot.WireAudioHandler();
                    _logger.LogInformation("[Orchestrator] Step 6 completed: Audio handler wired");
                }
                else
                {
                    _logger.LogError("[Orchestrator] === CALLHANDLER NOT FOUND ===");
                    _logger.LogError("[Orchestrator] ThreadId {ThreadId} has no associated CallHandler", threadId);
                    _logger.LogError("[Orchestrator] Available CallHandlers: {Count}", _botService.CallHandlers.Count);
                    foreach (var kvp in _botService.CallHandlers)
                    {
                        _logger.LogError("[Orchestrator]   - {Key}", kvp.Key);
                    }
                    _logger.LogError("[Orchestrator] Bot startup aborted, cleaning up...");
                    await webSocket.CloseAsync();
                    managedBot.Dispose();
                    return;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError("[Orchestrator] === TEAMS JOIN FAILED ===");
                _logger.LogError(ex, "[Orchestrator] Exception: {Message}", ex.Message);
                if (ex.InnerException != null)
                {
                    _logger.LogError("[Orchestrator] Inner Exception: {Inner}", ex.InnerException.Message);
                }
                _logger.LogError("[Orchestrator] Bot startup aborted, cleaning up...");
                await webSocket.CloseAsync();
                managedBot.Dispose();
                return;
            }

            // Add to active bots
            _logger.LogInformation("[Orchestrator] Step 7: Adding bot to active bots dictionary...");
            if (!_activeBots.TryAdd(key, managedBot))
            {
                _logger.LogWarning("[Orchestrator] Failed to add bot to dictionary (race condition?)");
                managedBot.Dispose();
                return;
            }

            // Publish meeting-joined event to TeamsAppService
            await _mqttService.PublishMeetingJoinedAsync(payload.Session.Id, payload.Channel.Id, managedBot.ThreadId!, payload.Channel.Translations);

            // Update status
            await _mqttService.PublishStatusAsync(_activeBots.Count);

            _logger.LogInformation("[Orchestrator] ========================================");
            _logger.LogInformation("[Orchestrator] === BOT STARTED SUCCESSFULLY ===");
            _logger.LogInformation("[Orchestrator] Key: {Key}", key);
            _logger.LogInformation("[Orchestrator] Active bots: {Count}", _activeBots.Count);
            _logger.LogInformation("[Orchestrator] ========================================");
        }

        private async Task WaitForCallHandlerAsync(string threadId, int maxWaitMs = 10000)
        {
            var startTime = DateTime.UtcNow;
            var checkCount = 0;

            while ((DateTime.UtcNow - startTime).TotalMilliseconds < maxWaitMs)
            {
                checkCount++;
                if (_botService.CallHandlers.ContainsKey(threadId))
                {
                    var elapsed = (DateTime.UtcNow - startTime).TotalMilliseconds;
                    _logger.LogInformation("[Orchestrator] CallHandler found after {Elapsed}ms ({Checks} checks)",
                        elapsed, checkCount);
                    return;
                }
                await Task.Delay(100);
            }

            var totalElapsed = (DateTime.UtcNow - startTime).TotalMilliseconds;
            _logger.LogWarning("[Orchestrator] === CALLHANDLER TIMEOUT ===");
            _logger.LogWarning("[Orchestrator] Waited {Elapsed}ms ({Checks} checks) for threadId {ThreadId}",
                totalElapsed, checkCount, threadId);
        }

        private async Task StopBotAsync(string sessionId, string channelId)
        {
            var key = $"{sessionId}_{channelId}";

            _logger.LogInformation("[Orchestrator] ========================================");
            _logger.LogInformation("[Orchestrator] === STOPPING BOT ===");
            _logger.LogInformation("[Orchestrator] Session: {SessionId}", sessionId);
            _logger.LogInformation("[Orchestrator] Channel: {ChannelId}", channelId);
            _logger.LogInformation("[Orchestrator] Key: {Key}", key);
            _logger.LogInformation("[Orchestrator] ========================================");

            if (!_activeBots.TryRemove(key, out var managedBot))
            {
                _logger.LogWarning("[Orchestrator] Bot not found in active bots for key {Key}", key);
                _logger.LogWarning("[Orchestrator] Active bot keys: [{Keys}]",
                    string.Join(", ", _activeBots.Keys));
                return;
            }

            _logger.LogInformation("[Orchestrator] Bot removed from active bots. ThreadId: {ThreadId}",
                managedBot.ThreadId ?? "null");

            // Publish meeting-left event to TeamsAppService before cleanup
            if (!string.IsNullOrEmpty(managedBot.ThreadId))
            {
                try
                {
                    await _mqttService.PublishMeetingLeftAsync(sessionId, channelId, managedBot.ThreadId);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[TeamsMediaBot] Error publishing meeting-left event");
                }
            }

            // Publish session unmapping to MQTT to clear the retained mapping
            _logger.LogInformation("[Orchestrator] Step 1: Publishing session unmapping...");
            try
            {
                await _mqttService.PublishSessionUnmappingAsync(sessionId);
                _logger.LogInformation("[Orchestrator] Session unmapping published");
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Orchestrator] Failed to publish session unmapping: {Message}", ex.Message);
            }

            // Close WebSocket
            _logger.LogInformation("[Orchestrator] Step 2: Closing WebSocket...");
            try
            {
                await managedBot.WebSocket.CloseAsync();
                _logger.LogInformation("[Orchestrator] WebSocket closed");
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Orchestrator] Failed to close WebSocket: {Message}", ex.Message);
            }

            // Leave Teams meeting
            if (!string.IsNullOrEmpty(managedBot.ThreadId))
            {
                _logger.LogInformation("[Orchestrator] Step 3: Ending Teams call for threadId {ThreadId}...",
                    managedBot.ThreadId);
                try
                {
                    await _botService.EndCallByThreadIdAsync(managedBot.ThreadId);
                    _logger.LogInformation("[Orchestrator] Teams call ended");
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[Orchestrator] Failed to end Teams call: {Message}", ex.Message);
                }
            }
            else
            {
                _logger.LogInformation("[Orchestrator] Step 3: No ThreadId, skipping Teams call cleanup");
            }

            // Dispose managed bot
            _logger.LogInformation("[Orchestrator] Step 4: Disposing managed bot...");
            managedBot.Dispose();

            // Update status
            await _mqttService.PublishStatusAsync(_activeBots.Count);

            _logger.LogInformation("[Orchestrator] ========================================");
            _logger.LogInformation("[Orchestrator] === BOT STOPPED ===");
            _logger.LogInformation("[Orchestrator] Key: {Key}", key);
            _logger.LogInformation("[Orchestrator] Remaining active bots: {Count}", _activeBots.Count);
            _logger.LogInformation("[Orchestrator] ========================================");
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
