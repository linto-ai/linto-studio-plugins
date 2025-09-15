using System;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Http;
using BotService.WebSocket;

namespace BotService.Controllers
{
    [RoutePrefix("api/bot")]
    public class BotController : ApiController
    {
        private readonly TeamsBot _bot;

        public BotController(TeamsBot bot)
        {
            _bot = bot;
        }

        [HttpPost]
        [Route("join")]
        public async Task<IHttpActionResult> Join([FromBody] JoinRequest request, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(request.JoinUrl))
                return BadRequest("JoinUrl is required");

            if (string.IsNullOrWhiteSpace(request.WebSocketUrl))
                return BadRequest("WebSocketUrl is required");

            try
            {
                var config = new WebSocketConfiguration(
                    request.WebSocketUrl,
                    request.StreamId,
                    request.AudioFormat ?? "PCM16",
                    request.SampleRate ?? 16000,
                    request.Channels ?? 1);

                await _bot.JoinMeetingAsync(new Uri(request.JoinUrl), config, cancellationToken);
                return Ok(new { 
                    message = "Meeting join initiated successfully",
                    webSocketUrl = config.WebSocketUrl,
                    streamId = config.StreamId,
                    audioFormat = config.AudioFormat
                });
            }
            catch (Exception ex)
            {
                return InternalServerError(new Exception(ex.Message));
            }
        }

        [HttpGet]
        [Route("test-connection")]
        public async Task<IHttpActionResult> TestConnection()
        {
            try
            {
                var isConnected = await _bot.TestGraphConnectionAsync();
                return Ok(new { connected = isConnected });
            }
            catch (Exception ex)
            {
                return InternalServerError(new Exception(ex.Message));
            }
        }

        [HttpPost]
        [Route("messages")]
        public async Task<IHttpActionResult> Messages([FromBody] object activity)
        {
            try
            {
                await _bot.HandleWebhookActivityAsync(activity);
                return Ok();
            }
            catch (Exception ex)
            {
                return InternalServerError(new Exception(ex.Message));
            }
        }


        [HttpPost]
        [Route("test-join")]
        public async Task<IHttpActionResult> TestJoin([FromBody] TestJoinRequest request, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(request.JoinUrl))
                return BadRequest("JoinUrl is required");

            try
            {
                // Create a dummy WebSocket config that won't be used
                var dummyConfig = new WebSocketConfiguration(
                    "ws://dummy/audio",
                    "test-stream",
                    "PCM16",
                    16000,
                    1);

                // This will now continue even if WebSocket fails
                await _bot.JoinMeetingAsync(new Uri(request.JoinUrl), dummyConfig, cancellationToken);
                return Ok(new { 
                    message = "Teams meeting join test completed",
                    joinUrl = request.JoinUrl,
                    note = "WebSocket connection skipped for testing"
                });
            }
            catch (Exception ex)
            {
                return InternalServerError(new Exception(ex.Message));
            }
        }
    }

    public class JoinRequest
    {
        public string JoinUrl { get; set; }
        public string WebSocketUrl { get; set; }
        public string StreamId { get; set; }
        public string AudioFormat { get; set; }
        public int? SampleRate { get; set; }
        public int? Channels { get; set; }
        
        // Additional fields for Teams context
        public string MeetingId { get; set; }
        public string ChatId { get; set; }
        public string TenantId { get; set; }
    }

    public class TestJoinRequest
    {
        public string JoinUrl { get; set; }
    }
}
