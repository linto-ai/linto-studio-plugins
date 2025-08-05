using System;
using System.Threading;
using System.Threading.Tasks;
using BotService;
using BotService.WebSocket;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace BotService.Tests
{
    public class TeamsBotTests
    {
        [Fact]
        public async Task JoinMeetingAsync_UsesWebSocketStreamer()
        {
            var streamer = new Mock<IWebSocketAudioStreamer>();
            var configuration = new Mock<IConfiguration>();
            
            // Setup mock configuration
            configuration.Setup(c => c["AZURE_TENANT_ID"]).Returns("test-tenant");
            configuration.Setup(c => c["AZURE_CLIENT_ID"]).Returns("test-client");
            configuration.Setup(c => c["AZURE_CLIENT_SECRET"]).Returns("test-secret");
            
            var bot = new TeamsBot(NullLogger<TeamsBot>.Instance, streamer.Object, configuration.Object);
            var config = new WebSocketConfiguration("ws://localhost:8080/audio", "test-stream");
            
            await bot.JoinMeetingAsync(new Uri("https://test"), config, CancellationToken.None);
            await bot.HandleAudioFrameAsync(new byte[160], CancellationToken.None);
            
            streamer.Verify(s => s.Configure("ws://localhost:8080/audio"), Times.Once);
            streamer.Verify(s => s.ConnectAsync(It.IsAny<CancellationToken>()), Times.Once);
            streamer.Verify(s => s.SendAudioAsync(It.IsAny<ReadOnlyMemory<byte>>(), It.IsAny<CancellationToken>()), Times.Once);
        }
    }
}
