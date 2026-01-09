using Microsoft.AspNetCore.SignalR;

namespace LiveCaptionsServer.Hubs;

/// <summary>
/// SignalR hub for real-time caption streaming to connected clients.
/// Clients join groups based on sessionId and channelId to receive targeted captions.
///
/// Protocol:
/// - Client connects to hub
/// - Client calls JoinSession(sessionId, channelId) to subscribe to a specific session
/// - Server sends "ReceiveCaption" events with CaptionPayload to the group
/// - Client calls LeaveSession(sessionId, channelId) when done
/// </summary>
public sealed class CaptionsHub : Hub
{
    private readonly ILogger<CaptionsHub> _logger;

    public CaptionsHub(ILogger<CaptionsHub> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Join a session group to receive captions for a specific session/channel combination.
    /// </summary>
    /// <param name="sessionId">The E-Meeting session identifier.</param>
    /// <param name="channelId">The channel identifier within the session.</param>
    public async Task JoinSession(string sessionId, string channelId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(channelId))
        {
            _logger.LogWarning("[CaptionsHub] Client {ConnectionId} attempted to join with invalid session/channel",
                Context.ConnectionId);
            return;
        }

        var groupName = GetGroupName(sessionId, channelId);
        await Groups.AddToGroupAsync(Context.ConnectionId, groupName);

        _logger.LogInformation("[CaptionsHub] Client {ConnectionId} joined group {Group}",
            Context.ConnectionId, groupName);
    }

    /// <summary>
    /// Leave a session group to stop receiving captions.
    /// </summary>
    /// <param name="sessionId">The E-Meeting session identifier.</param>
    /// <param name="channelId">The channel identifier within the session.</param>
    public async Task LeaveSession(string sessionId, string channelId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(channelId))
        {
            return;
        }

        var groupName = GetGroupName(sessionId, channelId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, groupName);

        _logger.LogInformation("[CaptionsHub] Client {ConnectionId} left group {Group}",
            Context.ConnectionId, groupName);
    }

    /// <summary>
    /// Called when a client connects to the hub.
    /// </summary>
    public override Task OnConnectedAsync()
    {
        _logger.LogInformation("[CaptionsHub] Client connected: {ConnectionId} from {RemoteIp}",
            Context.ConnectionId,
            Context.GetHttpContext()?.Connection.RemoteIpAddress);
        return base.OnConnectedAsync();
    }

    /// <summary>
    /// Called when a client disconnects from the hub.
    /// </summary>
    public override Task OnDisconnectedAsync(Exception? exception)
    {
        if (exception != null)
        {
            _logger.LogWarning(exception, "[CaptionsHub] Client {ConnectionId} disconnected with error",
                Context.ConnectionId);
        }
        else
        {
            _logger.LogInformation("[CaptionsHub] Client disconnected: {ConnectionId}", Context.ConnectionId);
        }
        return base.OnDisconnectedAsync(exception);
    }

    /// <summary>
    /// Gets the SignalR group name for a session/channel combination.
    /// Format: {sessionId}_{channelId}
    /// </summary>
    public static string GetGroupName(string sessionId, string channelId) => $"{sessionId}_{channelId}";
}
