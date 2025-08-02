using Microsoft.AspNetCore.Mvc;
using System;
using System.Threading;
using System.Threading.Tasks;
using BotService.Srt;

namespace BotService.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class BotController : ControllerBase
    {
        private readonly TeamsBot _bot;

        public BotController(TeamsBot bot)
        {
            _bot = bot;
        }

        [HttpPost("join")]
        public async Task<IActionResult> Join([FromBody] JoinRequest request, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(request.JoinUrl))
                return BadRequest("JoinUrl is required");

            try
            {
                var config = new SrtConfiguration(request.SrtHost, request.SrtPort, request.SrtLatency, request.SrtStreamId);
                await _bot.JoinMeetingAsync(new Uri(request.JoinUrl), config, cancellationToken);
                return Ok(new { message = "Meeting join initiated successfully" });
            }
            catch (Exception ex)
            {
                return StatusCode(500, new { error = ex.Message });
            }
        }

        [HttpGet("test-connection")]
        public async Task<IActionResult> TestConnection()
        {
            try
            {
                var isConnected = await _bot.TestGraphConnectionAsync();
                return Ok(new { connected = isConnected });
            }
            catch (Exception ex)
            {
                return StatusCode(500, new { error = ex.Message });
            }
        }

        [HttpPost("messages")]
        public async Task<IActionResult> Messages([FromBody] object activity)
        {
            try
            {
                await _bot.HandleWebhookActivityAsync(activity);
                return Ok();
            }
            catch (Exception ex)
            {
                return StatusCode(500, new { error = ex.Message });
            }
        }
    }

    public record JoinRequest(string JoinUrl, string SrtHost, int SrtPort, int SrtLatency, string SrtStreamId);
}
