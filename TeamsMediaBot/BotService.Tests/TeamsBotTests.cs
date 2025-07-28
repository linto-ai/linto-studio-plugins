using System;
using System.Threading;
using System.Threading.Tasks;
using BotService;
using BotService.Srt;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace BotService.Tests
{
    public class TeamsBotTests
    {
        [Fact]
        public async Task JoinMeetingAsync_UsesSrtWriter()
        {
            var writer = new Mock<ISrtWriter>();
            var bot = new TeamsBot(NullLogger<TeamsBot>.Instance, writer.Object);
            var config = new SrtConfiguration("localhost", 9000, 120, "");
            await bot.JoinMeetingAsync(new Uri("https://test"), config, CancellationToken.None);
            await bot.HandleAudioFrameAsync(new byte[160], CancellationToken.None);
            writer.Verify(w => w.Configure("localhost", 9000, 120, ""), Times.Once);
            writer.Verify(w => w.SendAsync(It.IsAny<ReadOnlyMemory<byte>>(), CancellationToken.None), Times.Once);
        }
    }
}
