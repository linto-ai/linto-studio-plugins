using Microsoft.AspNetCore.Mvc;
using System;
using System.Threading;
using System.Threading.Tasks;

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
                return BadRequest();

            await _bot.JoinMeetingAsync(new Uri(request.JoinUrl), cancellationToken);
            return Ok();
        }
    }

    public record JoinRequest(string JoinUrl);
}
