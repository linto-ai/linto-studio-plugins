using MediaLogLevel = Microsoft.Skype.Bots.Media.LogLevel;

namespace TeamsMediaBot.Bot
{
    /// <summary>
    /// The MediaPlatformLogger.
    /// </summary>
    public class BotMediaLogger : IBotMediaLogger
    {
        /// <summary>
        /// The logger
        /// </summary>
        private readonly ILogger _logger;

        /// <summary>
        /// Initializes a new instance of the <see cref="ExceptionLogger" /> class.
        /// </summary>
        /// <param name="logger">Graph logger.</param>
        public BotMediaLogger(ILogger<BotMediaLogger> logger)
        {
            _logger = logger;
        }

        /// <summary>
        /// Media platform error messages that are expected during normal teardown
        /// and should be downgraded from Error to Warning.
        /// </summary>
        private static readonly string[] TeardownErrorPatterns = new[]
        {
            "Endpoints not found",
            "GetAllChannelsQoe",
            "MediaPerf is not registered",
        };

        public void WriteLog(MediaLogLevel level, string logStatement)
        {
            LogLevel logLevel;
            switch (level)
            {
                case MediaLogLevel.Error:
                    // Downgrade known teardown noise from Error to Warning
                    logLevel = IsTeardownNoise(logStatement) ? LogLevel.Warning : LogLevel.Error;
                    break;
                case MediaLogLevel.Warning:
                    logLevel = LogLevel.Warning;
                    break;
                case MediaLogLevel.Information:
                    logLevel = LogLevel.Information;
                    break;
                case MediaLogLevel.Verbose:
                    logLevel = LogLevel.Trace;
                    break;
                default:
                    logLevel = LogLevel.Trace;
                    break;
            }

            this._logger.Log(logLevel, logStatement);
        }

        private static bool IsTeardownNoise(string logStatement)
        {
            foreach (var pattern in TeardownErrorPatterns)
            {
                if (logStatement.Contains(pattern, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }
    }
}
