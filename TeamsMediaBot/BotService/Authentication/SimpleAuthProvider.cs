using System;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Graph.Communications.Client.Authentication;
using Microsoft.Graph.Communications.Common;
using Azure.Identity;
using Azure.Core;

namespace BotService.Authentication
{
    public class SimpleAuthProvider : IRequestAuthenticationProvider
    {
        private readonly string _clientId;
        private readonly string _clientSecret;
        private readonly string _tenantId;
        private readonly ILogger _logger;
        private readonly ClientSecretCredential _credential;

        public SimpleAuthProvider(string clientId, string clientSecret, ILogger logger)
        {
            _clientId = clientId ?? throw new ArgumentNullException(nameof(clientId));
            _clientSecret = clientSecret ?? throw new ArgumentNullException(nameof(clientSecret));
            _tenantId = "7b167ee1-a46f-4616-9281-d9cf574c5119"; // Use the tenant ID from config
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));

            _credential = new ClientSecretCredential(
                _tenantId,
                _clientId, 
                _clientSecret,
                new ClientSecretCredentialOptions
                {
                    AuthorityHost = AzureAuthorityHosts.AzurePublicCloud
                });
        }

        public async Task AuthenticateOutboundRequestAsync(HttpRequestMessage request, string tenant)
        {
            try
            {
                // Get access token for Graph Communications API
                var tokenRequest = new TokenRequestContext(new[] { "https://graph.microsoft.com/.default" });
                var tokenResult = await _credential.GetTokenAsync(tokenRequest);

                if (tokenResult.Token != null)
                {
                    request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", tokenResult.Token);
                    _logger.LogDebug("Successfully authenticated outbound request");
                }
                else
                {
                    _logger.LogError("Failed to obtain access token - token is null");
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to authenticate outbound request");
                throw;
            }
        }

        public Task<RequestValidationResult> ValidateInboundRequestAsync(HttpRequestMessage request)
        {
            // For simplicity, we'll allow all inbound requests in this implementation
            // In production, you should validate the requests properly
            _logger.LogDebug("Validating inbound request (simplified validation)");
            
            return Task.FromResult(new RequestValidationResult
            {
                IsValid = true
            });
        }
    }
}