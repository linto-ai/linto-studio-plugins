namespace BotService.Srt
{
    public record SrtConfiguration(string Host, int Port, int Latency, string StreamId);
}
