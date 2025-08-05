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
        [Route("~/api/callbacks")]
        public async Task<IHttpActionResult> Callbacks([FromBody] object callbackData)
        {
            try
            {
                // Handle Communications SDK callbacks
                await _bot.HandleCommunicationsCallbackAsync(callbackData);
                return Ok();
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
    }
}
