using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Moq;
using TeamsMediaBot.Models.Captions;
using TeamsMediaBot.Models.Mqtt;
using TeamsMediaBot.Services.Mqtt;
using TeamsMediaBot.Services.SignalR;
using Xunit;

namespace TeamsMediaBot.Tests.Services.SignalR;

public class CaptionsBroadcasterTests
{
    private readonly Mock<ILogger<CaptionsBroadcaster>> _loggerMock;
    private readonly Mock<IMqttService> _mqttServiceMock;
    private readonly Mock<IHubContext<CaptionsHub>> _hubContextMock;
    private readonly Mock<IHubClients> _hubClientsMock;
    private readonly Mock<IClientProxy> _clientProxyMock;
    private readonly CaptionsBroadcaster _broadcaster;

    public CaptionsBroadcasterTests()
    {
        _loggerMock = new Mock<ILogger<CaptionsBroadcaster>>();
        _mqttServiceMock = new Mock<IMqttService>();
        _hubContextMock = new Mock<IHubContext<CaptionsHub>>();
        _hubClientsMock = new Mock<IHubClients>();
        _clientProxyMock = new Mock<IClientProxy>();

        _hubContextMock.Setup(h => h.Clients).Returns(_hubClientsMock.Object);
        _hubClientsMock.Setup(c => c.Group(It.IsAny<string>())).Returns(_clientProxyMock.Object);

        _broadcaster = new CaptionsBroadcaster(
            _loggerMock.Object,
            _mqttServiceMock.Object,
            _hubContextMock.Object);
    }

    [Fact]
    public async Task StartAsync_ShouldSubscribeToTranscriptionEvents()
    {
        // Act
        await _broadcaster.StartAsync(CancellationToken.None);

        // Assert
        _mqttServiceMock.VerifyAdd(
            m => m.OnTranscription += It.IsAny<EventHandler<(string, string, TranscriptionMessage, bool)>>(),
            Times.Once);
    }

    [Fact]
    public async Task StopAsync_ShouldUnsubscribeFromTranscriptionEvents()
    {
        // Arrange
        await _broadcaster.StartAsync(CancellationToken.None);

        // Act
        await _broadcaster.StopAsync(CancellationToken.None);

        // Assert
        _mqttServiceMock.VerifyRemove(
            m => m.OnTranscription -= It.IsAny<EventHandler<(string, string, TranscriptionMessage, bool)>>(),
            Times.Once);
    }

    [Fact]
    public async Task WhenTranscriptionReceived_ShouldBroadcastToCorrectGroup()
    {
        // Arrange
        var sessionId = "session-123";
        var channelId = "channel-456";
        var expectedGroupName = $"{sessionId}_{channelId}";
        var message = new TranscriptionMessage
        {
            Text = "Hello, world!",
            Language = "en-US"
        };

        EventHandler<(string, string, TranscriptionMessage, bool)>? capturedHandler = null;
        _mqttServiceMock
            .SetupAdd(m => m.OnTranscription += It.IsAny<EventHandler<(string, string, TranscriptionMessage, bool)>>())
            .Callback<EventHandler<(string, string, TranscriptionMessage, bool)>>(handler => capturedHandler = handler);

        await _broadcaster.StartAsync(CancellationToken.None);

        // Act
        capturedHandler?.Invoke(_mqttServiceMock.Object, (sessionId, channelId, message, true));

        // Wait a bit for the async void handler to complete
        await Task.Delay(100);

        // Assert
        _hubClientsMock.Verify(c => c.Group(expectedGroupName), Times.Once);
        _clientProxyMock.Verify(
            c => c.SendCoreAsync(
                "ReceiveCaption",
                It.Is<object[]>(args => args.Length == 1 && args[0] is CaptionPayload),
                default),
            Times.Once);
    }

    [Fact]
    public async Task WhenTranscriptionReceived_ShouldCreateCorrectCaptionPayload()
    {
        // Arrange
        var sessionId = "session-123";
        var channelId = "channel-456";
        var message = new TranscriptionMessage
        {
            Text = "Test transcription",
            SpeakerId = "speaker-1",
            Language = "fr-FR",
            Start = 1000,
            End = 2000,
            Translations = new Dictionary<string, string> { { "en", "Test transcription" } }
        };
        var isFinal = true;

        CaptionPayload? capturedPayload = null;
        _clientProxyMock
            .Setup(c => c.SendCoreAsync("ReceiveCaption", It.IsAny<object[]>(), default))
            .Callback<string, object[], CancellationToken>((method, args, ct) =>
            {
                if (args.Length > 0 && args[0] is CaptionPayload payload)
                {
                    capturedPayload = payload;
                }
            })
            .Returns(Task.CompletedTask);

        EventHandler<(string, string, TranscriptionMessage, bool)>? capturedHandler = null;
        _mqttServiceMock
            .SetupAdd(m => m.OnTranscription += It.IsAny<EventHandler<(string, string, TranscriptionMessage, bool)>>())
            .Callback<EventHandler<(string, string, TranscriptionMessage, bool)>>(handler => capturedHandler = handler);

        await _broadcaster.StartAsync(CancellationToken.None);

        // Act
        capturedHandler?.Invoke(_mqttServiceMock.Object, (sessionId, channelId, message, isFinal));
        await Task.Delay(100);

        // Assert
        Assert.NotNull(capturedPayload);
        Assert.Equal(sessionId, capturedPayload!.SessionId);
        Assert.Equal(channelId, capturedPayload.ChannelId);
        Assert.Equal(message.Text, capturedPayload.Text);
        Assert.Equal(message.SpeakerId, capturedPayload.SpeakerId);
        Assert.Equal(message.Language, capturedPayload.Language);
        Assert.Equal(isFinal, capturedPayload.IsFinal);
        Assert.Equal(message.Start, capturedPayload.Start);
        Assert.Equal(message.End, capturedPayload.End);
        Assert.Equal(message.Translations, capturedPayload.Translations);
    }

    [Fact]
    public async Task WhenTranscriptionReceived_WithPartialTranscription_ShouldSetIsFinalFalse()
    {
        // Arrange
        var message = new TranscriptionMessage { Text = "Partial..." };

        CaptionPayload? capturedPayload = null;
        _clientProxyMock
            .Setup(c => c.SendCoreAsync("ReceiveCaption", It.IsAny<object[]>(), default))
            .Callback<string, object[], CancellationToken>((method, args, ct) =>
            {
                if (args.Length > 0 && args[0] is CaptionPayload payload)
                {
                    capturedPayload = payload;
                }
            })
            .Returns(Task.CompletedTask);

        EventHandler<(string, string, TranscriptionMessage, bool)>? capturedHandler = null;
        _mqttServiceMock
            .SetupAdd(m => m.OnTranscription += It.IsAny<EventHandler<(string, string, TranscriptionMessage, bool)>>())
            .Callback<EventHandler<(string, string, TranscriptionMessage, bool)>>(handler => capturedHandler = handler);

        await _broadcaster.StartAsync(CancellationToken.None);

        // Act - send partial transcription (isFinal = false)
        capturedHandler?.Invoke(_mqttServiceMock.Object, ("session", "channel", message, false));
        await Task.Delay(100);

        // Assert
        Assert.NotNull(capturedPayload);
        Assert.False(capturedPayload!.IsFinal);
    }

    [Fact]
    public async Task WhenBroadcastFails_ShouldLogErrorAndContinue()
    {
        // Arrange
        var message = new TranscriptionMessage { Text = "Test" };

        _clientProxyMock
            .Setup(c => c.SendCoreAsync("ReceiveCaption", It.IsAny<object[]>(), default))
            .ThrowsAsync(new Exception("SignalR connection failed"));

        EventHandler<(string, string, TranscriptionMessage, bool)>? capturedHandler = null;
        _mqttServiceMock
            .SetupAdd(m => m.OnTranscription += It.IsAny<EventHandler<(string, string, TranscriptionMessage, bool)>>())
            .Callback<EventHandler<(string, string, TranscriptionMessage, bool)>>(handler => capturedHandler = handler);

        await _broadcaster.StartAsync(CancellationToken.None);

        // Act - should not throw
        capturedHandler?.Invoke(_mqttServiceMock.Object, ("session", "channel", message, true));
        await Task.Delay(100);

        // Assert - error was logged
        _loggerMock.Verify(
            x => x.Log(
                LogLevel.Error,
                It.IsAny<EventId>(),
                It.Is<It.IsAnyType>((v, t) => true),
                It.IsAny<Exception>(),
                It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
            Times.Once);
    }
}
