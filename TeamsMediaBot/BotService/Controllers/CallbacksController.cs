using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using System.Web.Http;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;

namespace BotService.Controllers
{
    /// <summary>
    /// Handles webhook callbacks from Microsoft Graph Communications API
    /// </summary>
    [RoutePrefix("api/callbacks")]
    public class CallbacksController : ApiController
    {
        private readonly ILogger<CallbacksController> _logger;

        public CallbacksController(ILogger<CallbacksController> logger)
        {
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        /// <summary>
        /// Webhook endpoint for Communications SDK notifications
        /// </summary>
        [HttpPost]
        [Route("")]
        public async Task<HttpResponseMessage> HandleCallback()
        {
            try
            {
                _logger.LogInformation("Received webhook callback from Communications SDK");

                // Read the request body
                var content = await Request.Content.ReadAsStringAsync();
                _logger.LogDebug("Callback payload: {Payload}", content);

                // Parse the notification
                if (!string.IsNullOrEmpty(content))
                {
                    try
                    {
                        var notification = JsonConvert.DeserializeObject(content);
                        _logger.LogInformation("Successfully parsed callback notification");
                        
                        // Here you would typically process the notification
                        // For example: call state changes, media events, etc.
                        ProcessNotification(notification);
                    }
                    catch (JsonException ex)
                    {
                        _logger.LogError(ex, "Failed to parse callback JSON");
                    }
                }

                // Always return 200 OK to acknowledge receipt
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("OK")
                };
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error processing webhook callback");
                
                // Still return 200 to avoid retries from the service
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("Error processed")
                };
            }
        }

        /// <summary>
        /// Health check endpoint for the callback URL
        /// </summary>
        [HttpGet]
        [Route("health")]
        public HttpResponseMessage GetHealth()
        {
            _logger.LogInformation("Callback health check requested");
            
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("Callbacks endpoint is healthy")
            };
        }

        private void ProcessNotification(object notification)
        {
            _logger.LogInformation("Processing Communications SDK notification");
            
            // In a real implementation, you would:
            // 1. Parse the specific notification type
            // 2. Handle call state changes
            // 3. Process media events
            // 4. Update internal state
            // 5. Forward audio data to SRT if needed
            
            _logger.LogDebug("Notification processed successfully");
        }
    }
}