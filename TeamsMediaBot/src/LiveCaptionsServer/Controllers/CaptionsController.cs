using LiveCaptionsServer.Models;
using LiveCaptionsServer.Services;
using Microsoft.AspNetCore.Mvc;

namespace LiveCaptionsServer.Controllers;

/// <summary>
/// API controller for caption-related operations.
/// Provides endpoints for the Teams app to discover session mappings.
/// </summary>
[ApiController]
[Route("api/captions")]
public class CaptionsController : ControllerBase
{
    private readonly ISessionMappingCache _mappingCache;
    private readonly ILogger<CaptionsController> _logger;

    public CaptionsController(ISessionMappingCache mappingCache, ILogger<CaptionsController> logger)
    {
        _mappingCache = mappingCache;
        _logger = logger;
    }

    /// <summary>
    /// Gets session information by Teams meeting threadId.
    /// This endpoint is called by the Teams app to find which session/channel
    /// corresponds to the current meeting.
    /// </summary>
    /// <param name="threadId">The Teams meeting thread ID (e.g., "19:meeting_xxx@thread.v2")</param>
    /// <returns>Session info with sessionId and channelId, or 404 if not found</returns>
    [HttpGet("session")]
    [ProducesResponseType(typeof(SessionInfoResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<SessionInfoResponse> GetSessionByThreadId([FromQuery] string threadId)
    {
        if (string.IsNullOrWhiteSpace(threadId))
        {
            _logger.LogWarning("[CaptionsController] GetSessionByThreadId called without threadId");
            return BadRequest("threadId query parameter is required");
        }

        _logger.LogDebug("[CaptionsController] Looking up session for threadId: {ThreadId}", threadId);

        var mapping = _mappingCache.GetByThreadId(threadId);

        if (mapping == null)
        {
            _logger.LogDebug("[CaptionsController] No mapping found for threadId: {ThreadId}", threadId);
            return NotFound();
        }

        _logger.LogInformation("[CaptionsController] Found mapping: ThreadId={ThreadId} -> Session={SessionId}, Channel={ChannelId}",
            threadId, mapping.SessionId, mapping.ChannelId);

        return Ok(new SessionInfoResponse
        {
            SessionId = mapping.SessionId,
            ChannelId = mapping.ChannelId,
            EnableDisplaySub = mapping.EnableDisplaySub
        });
    }

    /// <summary>
    /// Lists all active session mappings.
    /// Useful for debugging and monitoring.
    /// </summary>
    /// <returns>List of all active session mappings</returns>
    [HttpGet("sessions")]
    [ProducesResponseType(typeof(IEnumerable<SessionMapping>), StatusCodes.Status200OK)]
    public ActionResult<IEnumerable<SessionMapping>> GetAllSessions()
    {
        var mappings = _mappingCache.GetAll();
        _logger.LogDebug("[CaptionsController] Returning {Count} active session mappings", mappings.Count());
        return Ok(mappings);
    }

    /// <summary>
    /// Gets a specific session mapping by session ID.
    /// </summary>
    /// <param name="sessionId">The session ID</param>
    /// <returns>Session mapping or 404 if not found</returns>
    [HttpGet("sessions/{sessionId}")]
    [ProducesResponseType(typeof(SessionMapping), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<SessionMapping> GetSessionById(string sessionId)
    {
        var mapping = _mappingCache.GetBySessionId(sessionId);

        if (mapping == null)
        {
            return NotFound();
        }

        return Ok(mapping);
    }
}
