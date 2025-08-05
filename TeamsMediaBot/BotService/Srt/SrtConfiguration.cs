namespace BotService.Srt
{
    public class SrtConfiguration
    {
        public string Host { get; set; }
        public int Port { get; set; }
        public int Latency { get; set; }
        public string StreamId { get; set; }
        
        public SrtConfiguration(string host, int port, int latency, string streamId)
        {
            Host = host;
            Port = port;
            Latency = latency;
            StreamId = streamId;
        }
    }
}
