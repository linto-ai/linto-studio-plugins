using System.Threading;
using System.Threading.Tasks;
using BotService.Srt;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace BotService.Tests
{
    public class SrtWriterTests
    {
        [Fact(Skip = "Requires libsrt library")]
        public async Task SendAsync_ConnectsOnFirstSend()
        {
            var logger = NullLogger<SrtWriter>.Instance;
            var writer = new SrtWriter(logger);
            writer.Configure("localhost", 9000, 120, "");
            await writer.SendAsync(new byte[160], CancellationToken.None);
            await writer.DisposeAsync();
        }
    }
}
