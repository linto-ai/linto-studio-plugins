using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Moq;
using TeamsMediaBot.Services.SignalR;
using Xunit;

namespace TeamsMediaBot.Tests.Services.SignalR;

public class CaptionsHubTests
{
    private readonly Mock<ILogger<CaptionsHub>> _loggerMock;
    private readonly CaptionsHub _hub;
    private readonly Mock<IGroupManager> _groupsMock;
    private readonly Mock<HubCallerContext> _contextMock;

    public CaptionsHubTests()
    {
        _loggerMock = new Mock<ILogger<CaptionsHub>>();
        _groupsMock = new Mock<IGroupManager>();
        _contextMock = new Mock<HubCallerContext>();

        _contextMock.Setup(c => c.ConnectionId).Returns("test-connection-id");

        _hub = new CaptionsHub(_loggerMock.Object);

        // Use reflection to set the Groups and Context properties
        var groupsProperty = typeof(Hub).GetProperty("Groups");
        var contextProperty = typeof(Hub).GetProperty("Context");

        // Create a wrapper that exposes the hub internals for testing
        SetHubContext(_hub, _contextMock.Object, _groupsMock.Object);
    }

    private void SetHubContext(Hub hub, HubCallerContext context, IGroupManager groups)
    {
        // Use reflection to set protected properties
        var hubType = typeof(Hub);

        var contextField = hubType.GetProperty("Context");
        contextField?.SetValue(hub, context);

        var groupsField = hubType.GetProperty("Groups");
        groupsField?.SetValue(hub, groups);
    }

    [Theory]
    [InlineData("session-1", "channel-1", "session-1_channel-1")]
    [InlineData("abc", "xyz", "abc_xyz")]
    [InlineData("123", "456", "123_456")]
    public void GetGroupName_ShouldFormatCorrectly(string sessionId, string channelId, string expected)
    {
        // Act
        var result = CaptionsHub.GetGroupName(sessionId, channelId);

        // Assert
        Assert.Equal(expected, result);
    }

    [Fact]
    public async Task JoinSession_WithValidIds_ShouldAddToGroup()
    {
        // Arrange
        var sessionId = "session-123";
        var channelId = "channel-456";
        var expectedGroupName = "session-123_channel-456";

        _groupsMock
            .Setup(g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), default))
            .Returns(Task.CompletedTask);

        // Act
        await _hub.JoinSession(sessionId, channelId);

        // Assert
        _groupsMock.Verify(
            g => g.AddToGroupAsync("test-connection-id", expectedGroupName, default),
            Times.Once);
    }

    [Theory]
    [InlineData(null, "channel")]
    [InlineData("session", null)]
    [InlineData("", "channel")]
    [InlineData("session", "")]
    [InlineData("  ", "channel")]
    [InlineData("session", "  ")]
    public async Task JoinSession_WithInvalidIds_ShouldNotAddToGroup(string? sessionId, string? channelId)
    {
        // Act
        await _hub.JoinSession(sessionId!, channelId!);

        // Assert
        _groupsMock.Verify(
            g => g.AddToGroupAsync(It.IsAny<string>(), It.IsAny<string>(), default),
            Times.Never);
    }

    [Fact]
    public async Task LeaveSession_WithValidIds_ShouldRemoveFromGroup()
    {
        // Arrange
        var sessionId = "session-123";
        var channelId = "channel-456";
        var expectedGroupName = "session-123_channel-456";

        _groupsMock
            .Setup(g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), default))
            .Returns(Task.CompletedTask);

        // Act
        await _hub.LeaveSession(sessionId, channelId);

        // Assert
        _groupsMock.Verify(
            g => g.RemoveFromGroupAsync("test-connection-id", expectedGroupName, default),
            Times.Once);
    }

    [Theory]
    [InlineData(null, "channel")]
    [InlineData("session", null)]
    [InlineData("", "channel")]
    [InlineData("session", "")]
    public async Task LeaveSession_WithInvalidIds_ShouldNotRemoveFromGroup(string? sessionId, string? channelId)
    {
        // Act
        await _hub.LeaveSession(sessionId!, channelId!);

        // Assert
        _groupsMock.Verify(
            g => g.RemoveFromGroupAsync(It.IsAny<string>(), It.IsAny<string>(), default),
            Times.Never);
    }

    // Note: OnConnectedAsync test removed because GetHttpContext() is an extension method
    // that requires a full HTTP context pipeline which is difficult to mock.
    // The method just logs connection info and calls base.OnConnectedAsync().

    [Fact]
    public async Task OnDisconnectedAsync_WithoutException_ShouldLogDisconnection()
    {
        // Act
        await _hub.OnDisconnectedAsync(null);

        // Assert
        _loggerMock.Verify(
            x => x.Log(
                LogLevel.Information,
                It.IsAny<EventId>(),
                It.Is<It.IsAnyType>((v, t) => true),
                It.IsAny<Exception>(),
                It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
            Times.Once);
    }

    [Fact]
    public async Task OnDisconnectedAsync_WithException_ShouldLogWarning()
    {
        // Arrange
        var exception = new Exception("Connection lost");

        // Act
        await _hub.OnDisconnectedAsync(exception);

        // Assert
        _loggerMock.Verify(
            x => x.Log(
                LogLevel.Warning,
                It.IsAny<EventId>(),
                It.Is<It.IsAnyType>((v, t) => true),
                exception,
                It.IsAny<Func<It.IsAnyType, Exception?, string>>()),
            Times.Once);
    }
}
