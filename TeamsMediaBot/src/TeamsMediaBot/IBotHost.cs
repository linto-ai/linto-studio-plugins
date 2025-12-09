namespace TeamsMediaBot
{
    public interface IBotHost
    {
        Task StartAsync();

        Task StopAsync();
    }
}