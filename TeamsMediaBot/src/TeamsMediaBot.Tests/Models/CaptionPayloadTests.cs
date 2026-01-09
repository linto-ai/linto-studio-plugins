using TeamsMediaBot.Models.Captions;
using TeamsMediaBot.Models.Mqtt;
using Xunit;

namespace TeamsMediaBot.Tests.Models;

public class CaptionPayloadTests
{
    [Fact]
    public void FromTranscription_ShouldMapAllFields()
    {
        // Arrange
        var sessionId = "session-123";
        var channelId = "channel-456";
        var transcription = new TranscriptionMessage
        {
            Text = "Hello, world!",
            SpeakerId = "speaker-1",
            Language = "en-US",
            Start = 1000,
            End = 2000,
            Translations = new Dictionary<string, string>
            {
                { "fr", "Bonjour, monde!" },
                { "es", "Hola, mundo!" }
            }
        };
        var isFinal = true;

        // Act
        var payload = CaptionPayload.FromTranscription(sessionId, channelId, transcription, isFinal);

        // Assert
        Assert.Equal(sessionId, payload.SessionId);
        Assert.Equal(channelId, payload.ChannelId);
        Assert.Equal(transcription.Text, payload.Text);
        Assert.Equal(transcription.SpeakerId, payload.SpeakerId);
        Assert.Equal(transcription.Language, payload.Language);
        Assert.Equal(isFinal, payload.IsFinal);
        Assert.Equal(transcription.Start, payload.Start);
        Assert.Equal(transcription.End, payload.End);
        Assert.Equal(transcription.Translations, payload.Translations);
        Assert.True(payload.Timestamp <= DateTime.UtcNow);
        Assert.True(payload.Timestamp > DateTime.UtcNow.AddSeconds(-5));
    }

    [Fact]
    public void FromTranscription_WithPartialTranscription_ShouldSetIsFinalFalse()
    {
        // Arrange
        var transcription = new TranscriptionMessage
        {
            Text = "Partial text..."
        };

        // Act
        var payload = CaptionPayload.FromTranscription("session", "channel", transcription, isFinal: false);

        // Assert
        Assert.False(payload.IsFinal);
    }

    [Fact]
    public void FromTranscription_WithNullOptionalFields_ShouldHandleGracefully()
    {
        // Arrange
        var transcription = new TranscriptionMessage
        {
            Text = "Simple text"
            // SpeakerId, Language, Start, End, Translations are null
        };

        // Act
        var payload = CaptionPayload.FromTranscription("session", "channel", transcription, true);

        // Assert
        Assert.Equal("Simple text", payload.Text);
        Assert.Null(payload.SpeakerId);
        Assert.Null(payload.Language);
        Assert.Null(payload.Start);
        Assert.Null(payload.End);
        Assert.Null(payload.Translations);
    }

    [Fact]
    public void FromTranscription_ShouldSetTimestampToUtcNow()
    {
        // Arrange
        var before = DateTime.UtcNow;
        var transcription = new TranscriptionMessage { Text = "Test" };

        // Act
        var payload = CaptionPayload.FromTranscription("session", "channel", transcription, true);
        var after = DateTime.UtcNow;

        // Assert
        Assert.True(payload.Timestamp >= before);
        Assert.True(payload.Timestamp <= after);
    }

    [Fact]
    public void DefaultValues_ShouldBeEmpty()
    {
        // Arrange & Act
        var payload = new CaptionPayload();

        // Assert
        Assert.Equal(string.Empty, payload.SessionId);
        Assert.Equal(string.Empty, payload.ChannelId);
        Assert.Equal(string.Empty, payload.Text);
        Assert.False(payload.IsFinal);
    }
}
