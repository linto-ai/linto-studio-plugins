using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using BotService.Srt;

namespace BotService
{
    public sealed class TeamsBot
    {
        private readonly ILogger<TeamsBot> _logger;
        private readonly ISrtWriter _writer;

        public TeamsBot(ILogger<TeamsBot> logger, ISrtWriter writer)
        {
            _logger = logger;
            _writer = writer;
        }

        public async Task JoinMeetingAsync(Uri joinUrl, SrtConfiguration srtConfig, CancellationToken cancellationToken)
        {
            _logger.LogInformation("Joining meeting {JoinUrl}", joinUrl);
            _writer.Configure(srtConfig.Host, srtConfig.Port, srtConfig.Latency, srtConfig.StreamId);
            // TODO: Implement real Graph call join logic
            await Task.Delay(1000, cancellationToken); // placeholder
            _logger.LogInformation("Joined meeting");
        }

        public Task HandleAudioFrameAsync(ReadOnlyMemory<byte> frame, CancellationToken cancellationToken)
        {
            return _writer.SendAsync(frame, cancellationToken);
        }
    }
}
