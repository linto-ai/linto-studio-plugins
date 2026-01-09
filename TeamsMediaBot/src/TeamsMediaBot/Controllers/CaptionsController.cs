using Microsoft.AspNetCore.Mvc;
using TeamsMediaBot.Services.Orchestration;

namespace TeamsMediaBot.Controllers
{
    /// <summary>
    /// Controller for captions-related endpoints used by the Teams side panel.
    /// </summary>
    [ApiController]
    [Route("api/[controller]")]
    public class CaptionsController : ControllerBase
    {
        private readonly ILogger<CaptionsController> _logger;
        private readonly IBotOrchestratorService _orchestratorService;

        public CaptionsController(ILogger<CaptionsController> logger, IBotOrchestratorService orchestratorService)
        {
            _logger = logger;
            _orchestratorService = orchestratorService;
        }

        /// <summary>
        /// Get session info by Teams thread ID.
        /// Used by the side panel to find the session for SignalR subscription.
        /// </summary>
        /// <param name="threadId">The Teams meeting thread ID</param>
        /// <returns>Session and channel information</returns>
        [HttpGet("session")]
        public ActionResult<SessionInfo> GetSessionByThreadId([FromQuery] string threadId)
        {
            if (string.IsNullOrEmpty(threadId))
            {
                return BadRequest("threadId is required");
            }

            _logger.LogInformation("[CaptionsController] Looking up session for threadId: {ThreadId}", threadId);

            var bot = _orchestratorService.GetBotByThreadId(threadId);
            if (bot == null)
            {
                _logger.LogWarning("[CaptionsController] No active session found for threadId: {ThreadId}", threadId);
                return NotFound(new { message = "No active transcription session found for this meeting" });
            }

            return Ok(new SessionInfo
            {
                SessionId = bot.SessionId,
                ChannelId = bot.ChannelId,
                ThreadId = bot.ThreadId,
                EnableDisplaySub = bot.EnableDisplaySub
            });
        }

        /// <summary>
        /// List all active sessions (for debugging/admin purposes).
        /// </summary>
        [HttpGet("sessions")]
        public ActionResult<IEnumerable<SessionInfo>> GetAllSessions()
        {
            var sessions = _orchestratorService.GetAllBots()
                .Select(bot => new SessionInfo
                {
                    SessionId = bot.SessionId,
                    ChannelId = bot.ChannelId,
                    ThreadId = bot.ThreadId,
                    EnableDisplaySub = bot.EnableDisplaySub
                });

            return Ok(sessions);
        }
    }

    /// <summary>
    /// Session information returned to clients.
    /// </summary>
    public class SessionInfo
    {
        public string SessionId { get; set; } = string.Empty;
        public string ChannelId { get; set; } = string.Empty;
        public string? ThreadId { get; set; }
        public bool EnableDisplaySub { get; set; }
    }
}
