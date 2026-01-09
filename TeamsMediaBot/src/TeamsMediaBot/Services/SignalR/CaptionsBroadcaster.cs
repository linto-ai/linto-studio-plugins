using Microsoft.AspNetCore.SignalR;
using TeamsMediaBot.Models.Captions;
using TeamsMediaBot.Models.Mqtt;
using TeamsMediaBot.Services.Mqtt;

namespace TeamsMediaBot.Services.SignalR;

/// <summary>
/// Background service that listens to MQTT transcription events and broadcasts them via SignalR.
/// </summary>
public sealed class CaptionsBroadcaster : IHostedService
{
    private readonly ILogger<CaptionsBroadcaster> _logger;
    private readonly IMqttService _mqttService;
    private readonly IHubContext<CaptionsHub> _hubContext;

    public CaptionsBroadcaster(
        ILogger<CaptionsBroadcaster> logger,
        IMqttService mqttService,
        IHubContext<CaptionsHub> hubContext)
    {
        _logger = logger;
        _mqttService = mqttService;
        _hubContext = hubContext;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("[CaptionsBroadcaster] Starting SignalR caption broadcaster");

        // Subscribe to transcription events from MQTT service
        _mqttService.OnTranscription += HandleTranscription;

        _logger.LogInformation("[CaptionsBroadcaster] Subscribed to MQTT transcription events");
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("[CaptionsBroadcaster] Stopping SignalR caption broadcaster");

        // Unsubscribe from transcription events
        _mqttService.OnTranscription -= HandleTranscription;

        return Task.CompletedTask;
    }

    private async void HandleTranscription(object? sender, (string sessionId, string channelId, TranscriptionMessage message, bool isFinal) args)
    {
        try
        {
            var (sessionId, channelId, message, isFinal) = args;

            // Create caption payload
            var caption = CaptionPayload.FromTranscription(sessionId, channelId, message, isFinal);

            // Get the SignalR group name for this session/channel
            var groupName = CaptionsHub.GetGroupName(sessionId, channelId);

            // Broadcast to all connected clients in the group
            await _hubContext.Clients.Group(groupName).SendAsync("ReceiveCaption", caption);

            _logger.LogDebug("[CaptionsBroadcaster] Broadcast {Type} caption to group {Group}: {Text}",
                isFinal ? "final" : "partial", groupName, message.Text);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[CaptionsBroadcaster] Error broadcasting caption");
        }
    }
}
