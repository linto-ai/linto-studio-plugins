using Microsoft.Skype.Bots.Media;

namespace TeamsMediaBot.Bot
{
    public class MediaStreamEventArgs
    {
        public List<AudioMediaBuffer> AudioMediaBuffers { get; set; }
    }
}
