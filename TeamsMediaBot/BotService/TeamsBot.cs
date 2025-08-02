using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using Microsoft.Graph;
using Microsoft.Graph.Communications.Client;
using Microsoft.Graph.Communications.Common;
using Microsoft.Graph.Communications.Core.Serialization;
using Microsoft.Graph.Communications.Calls;
using Azure.Identity;
using BotService.Srt;

namespace BotService
{
    public sealed class TeamsBot : IAsyncDisposable
    {
        private readonly ILogger<TeamsBot> _logger;
        private readonly ISrtWriter _writer;
        private readonly GraphServiceClient _graphClient;
        private readonly ICommunicationsClient? _communicationsClient;
        private readonly string _tenantId;
        private readonly string _clientId;
        private readonly string _clientSecret;
        private readonly string _baseUrl;

        public TeamsBot(ILogger<TeamsBot> logger, ISrtWriter writer, IConfiguration configuration)
        {
            _logger = logger;
            _writer = writer;
            
            // Get configuration values
            _tenantId = configuration["AZURE_TENANT_ID"] ?? Environment.GetEnvironmentVariable("AZURE_TENANT_ID")
                ?? throw new InvalidOperationException("AZURE_TENANT_ID is required");
            _clientId = configuration["AZURE_CLIENT_ID"] ?? Environment.GetEnvironmentVariable("AZURE_CLIENT_ID")
                ?? throw new InvalidOperationException("AZURE_CLIENT_ID is required");
            _clientSecret = configuration["AZURE_CLIENT_SECRET"] ?? Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET")
                ?? throw new InvalidOperationException("AZURE_CLIENT_SECRET is required");
            _baseUrl = configuration["BOT_BASE_URL"] ?? Environment.GetEnvironmentVariable("BOT_BASE_URL")
                ?? "https://42b93925edd3.ngrok-free.app"; // fallback to current ngrok URL

            _graphClient = CreateGraphClient();
            _communicationsClient = CreateCommunicationsClient();
        }

        public async Task JoinMeetingAsync(Uri joinUrl, SrtConfiguration srtConfig, CancellationToken cancellationToken)
        {
            _logger.LogInformation("Joining meeting {JoinUrl}", joinUrl);
            _writer.Configure(srtConfig.Host, srtConfig.Port, srtConfig.Latency, srtConfig.StreamId);
            
            try
            {
                // Extract meeting info from join URL
                var meetingInfo = ExtractMeetingInfoFromUrl(joinUrl.ToString());
                _logger.LogInformation("Extracted meeting info: {Info}", meetingInfo);
                
                if (_communicationsClient != null)
                {
                    _logger.LogInformation("Using Communications SDK to join meeting");
                    await JoinWithCommunicationsSDK(meetingInfo, cancellationToken);
                }
                else
                {
                    _logger.LogInformation("Communications SDK not available - using Graph API approach");
                    await JoinWithGraphAPI(meetingInfo, cancellationToken);
                }
                
                _logger.LogInformation("Meeting join process completed");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to join meeting {JoinUrl}", joinUrl);
                throw;
            }
        }
        
        private async Task JoinWithCommunicationsSDK(string meetingInfo, CancellationToken cancellationToken)
        {
            // TODO: Implement real Communications SDK join logic
            _logger.LogInformation("Communications SDK join logic - requires Windows Server setup");
            await Task.Delay(500, cancellationToken);
        }
        
        private async Task JoinWithGraphAPI(string meetingInfo, CancellationToken cancellationToken)
        {
            try
            {
                _logger.LogInformation("Attempting to interact with meeting via Graph API");
                
                // Use our existing Graph API test method to verify connectivity
                var isConnected = await TestGraphConnectionAsync();
                if (isConnected)
                {
                    _logger.LogInformation("Graph API connection verified successfully");
                }
                else
                {
                    _logger.LogWarning("Graph API connection test failed, but continuing with meeting processing");
                }
                
                // Log meeting readiness
                _logger.LogInformation("Bot is ready to process meeting {MeetingInfo}", meetingInfo);
                _logger.LogInformation("Note: Audio streaming requires Communications SDK deployment on Windows Server");
                
                await Task.Delay(1000, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Graph API approach failed: {Message}", ex.Message);
                throw;
            }
        }

        public Task HandleAudioFrameAsync(ReadOnlyMemory<byte> frame, CancellationToken cancellationToken)
        {
            return _writer.SendAsync(frame, cancellationToken);
        }

        private GraphServiceClient CreateGraphClient()
        {
            try
            {
                // Create client credentials using Azure.Identity
                var options = new ClientSecretCredentialOptions
                {
                    AuthorityHost = AzureAuthorityHosts.AzurePublicCloud,
                };
                
                var clientSecretCredential = new ClientSecretCredential(
                    _tenantId,
                    _clientId,
                    _clientSecret,
                    options);
                
                // Create Graph client
                var graphClient = new GraphServiceClient(clientSecretCredential);
                
                _logger.LogInformation("Graph client created successfully");
                return graphClient;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to create Graph client");
                throw;
            }
        }
        
        private ICommunicationsClient? CreateCommunicationsClient()
        {
            try
            {
                _logger.LogInformation("Creating Communications client with base URL: {BaseUrl}", _baseUrl);
                
                // For development, we'll implement this later
                // The Communications SDK requires complex Windows-specific setup
                _logger.LogWarning("Communications client creation deferred - requires Windows Server media platform");
                
                return null;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to create Communications client: {Message}", ex.Message);
                return null;
            }
        }
        
        private string ExtractMeetingInfoFromUrl(string joinUrl)
        {
            // Extract meeting info from Teams join URL
            // Example: https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz/0?context=%7b%22Tid%22%3a%22abc%22%2c%22Oid%22%3a%22def%22%7d
            try
            {
                var uri = new Uri(joinUrl);
                var path = uri.AbsolutePath;
                
                // Extract the meeting ID from the path
                var segments = path.Split('/');
                if (segments.Length > 2)
                {
                    var meetingId = Uri.UnescapeDataString(segments[2]);
                    return $"MeetingID: {meetingId}";
                }
                
                return "Unable to parse meeting URL";
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to extract meeting info from URL: {Url}", joinUrl);
                return "URL parsing failed";
            }
        }
        
        public async Task<bool> TestGraphConnectionAsync()
        {
            try
            {
                _logger.LogInformation("Testing Graph API connection...");
                
                // For application permissions, we can't call /me, let's try a different endpoint
                // Try to get organization info instead
                var organization = await _graphClient.Organization.GetAsync();
                
                _logger.LogInformation("Graph connection test successful. Organization count: {Count}", organization?.Value?.Count ?? 0);
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Graph connection test failed. Error: {Error}", ex.Message);
                
                // Log more details for debugging
                if (ex.InnerException != null)
                {
                    _logger.LogError("Inner exception: {InnerError}", ex.InnerException.Message);
                }
                
                return false;
            }
        }
        
        public async Task HandleWebhookActivityAsync(object activity)
        {
            try
            {
                _logger.LogInformation("Received webhook activity: {Activity}", activity?.ToString() ?? "null");
                
                // Parse the activity and handle different types of Teams events
                // This is where we'll handle meeting invitations, participant changes, etc.
                
                // For now, just log the activity
                await Task.CompletedTask;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to handle webhook activity");
                throw;
            }
        }

        public async ValueTask DisposeAsync()
        {
            // Clean up resources
            _graphClient?.Dispose();
            _communicationsClient?.Dispose();
            await Task.CompletedTask;
        }
    }

    // Simple authentication provider for Communications SDK
    public class SimpleAuthProvider
    {
        private readonly string _clientId;
        private readonly string _clientSecret;
        private readonly ILogger _logger;

        public SimpleAuthProvider(string clientId, string clientSecret, ILogger logger)
        {
            _clientId = clientId;
            _clientSecret = clientSecret;
            _logger = logger;
        }

        public async Task<string> GetAccessTokenAsync()
        {
            try
            {
                // Use Azure.Identity to get token for Graph Communications
                var credential = new ClientSecretCredential(
                    "7b167ee1-a46f-4616-9281-d9cf574c5119", // tenant ID
                    _clientId,
                    _clientSecret);

                var tokenRequest = new Azure.Core.TokenRequestContext(
                    new[] { "https://graph.microsoft.com/.default" });

                var token = await credential.GetTokenAsync(tokenRequest);
                return token.Token;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to get access token");
                throw;
            }
        }
    }
}
