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
    /// <summary>
    /// Authentication provider for Microsoft Graph Communications SDK
    /// </summary>
    public class AuthenticationProvider : IRequestAuthenticationProvider
    {
        private readonly string _appId;
        private readonly string _appSecret;
        private readonly string _tenantId;
        private readonly ILogger _logger;
        private readonly ClientSecretCredential _credential;

        public AuthenticationProvider(string appId, string appSecret, string tenantId, ILogger logger)
        {
            _appId = appId ?? throw new ArgumentNullException(nameof(appId));
            _appSecret = appSecret ?? throw new ArgumentNullException(nameof(appSecret));
            _tenantId = tenantId ?? throw new ArgumentNullException(nameof(tenantId));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));

            _credential = new ClientSecretCredential(tenantId, appId, appSecret);
        }

        /// <summary>
        /// Authenticate the outbound request
        /// </summary>
        public async Task AuthenticateOutboundRequestAsync(HttpRequestMessage request, string tenantId)
        {
            try
            {
                _logger.LogInformation("Authenticating outbound request to {Uri}", request.RequestUri);

                // Get access token for Graph Communications
                var tokenRequest = new TokenRequestContext(
                    new[] { "https://graph.microsoft.com/.default" });
                
                var token = await _credential.GetTokenAsync(tokenRequest);
                
                // Add the token to the request
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token.Token);
                
                _logger.LogInformation("Successfully authenticated request");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to authenticate outbound request");
                throw;
            }
        }

        /// <summary>
        /// Authenticate the inbound request (for validating incoming requests from Teams)
        /// </summary>
        public Task<RequestValidationResult> ValidateInboundRequestAsync(HttpRequestMessage request)
        {
            // For now, we'll accept all requests
            // In production, you should validate the request signature
            _logger.LogInformation("Validating inbound request from {Uri}", request.RequestUri);
            
            return Task.FromResult(new RequestValidationResult()
            {
                IsValid = true,
                TenantId = _tenantId
            });
        }
    }
}