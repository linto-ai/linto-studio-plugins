using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Web.Http;

namespace BotService.Controllers
{
    /// <summary>
    /// Controller for Teams App configuration pages
    /// </summary>
    public class TeamsAppController : ApiController
    {

        /// <summary>
        /// Serves the Teams app configuration page
        /// </summary>
        [HttpGet]
        [Route("teams-app-configure")]
        public HttpResponseMessage GetConfigurePage()
        {
            Serilog.Log.Information("HTTP GET /teams-app-configure");
            var response = new HttpResponseMessage(HttpStatusCode.OK);
            
            var html = @"<!DOCTYPE html>
<html>
<head>
    <title>LinTO Bot Configuration</title>
    <script src='https://res.cdn.office.net/teams-js/2.7.1/js/MicrosoftTeams.min.js'></script>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 400px;
            margin: 0 auto;
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h2 { color: #444; margin-bottom: 20px; }
        p { color: #666; line-height: 1.6; margin-bottom: 20px; }
        .btn {
            background-color: #6264a7;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 4px;
            font-size: 16px;
            cursor: pointer;
            width: 100%;
            margin-top: 20px;
        }
        .btn:hover { background-color: #5b5fc7; }
        .btn:disabled { 
            background-color: #ccc; 
            cursor: not-allowed;
        }
        .status {
            text-align: center;
            margin-top: 15px;
            color: #28a745;
            display: none;
        }
    </style>
</head>
<body>
    <div class='container'>
        <h2>LinTO Media Bot</h2>
        <p>LinTO Bot will join your Teams meeting to capture and process audio in real-time.</p>
        <p>Click the button below to configure LinTO Bot for this meeting.</p>
        <button id='configBtn' class='btn' onclick='configureBot()'>Configure LinTO Bot</button>
        <div id='status' class='status'>✅ Configuration saved! You can now close this dialog.</div>
    </div>
    <script>
        let teamsContext = null;
        
        // Initialize Teams SDK
        microsoftTeams.app.initialize().then(() => {
            console.log('Teams SDK initialized');
            
            // Get Teams context
            microsoftTeams.app.getContext().then((context) => {
                teamsContext = context;
                console.log('Teams context:', context);
            });
            
            // Register save handler
            microsoftTeams.pages.config.registerOnSaveHandler((saveEvent) => {
                console.log('Save handler called');
                saveConfiguration()
                    .then(() => {
                        console.log('Calling saveEvent.notifySuccess');
                        saveEvent.notifySuccess();
                        console.log('Save notified as success');
                    })
                    .catch((error) => {
                        console.error('Save failed:', error);
                        saveEvent.notifyFailure(error.message || 'Configuration failed');
                    });
            });
        });
        
        function configureBot() {
            document.getElementById('configBtn').disabled = true;
            document.getElementById('configBtn').textContent = 'Configuring...';
            
            // Set validity state to true to enable Save button in Teams
            microsoftTeams.pages.config.setValidityState(true);
            
            // Show success message
            document.getElementById('status').style.display = 'block';
            document.getElementById('configBtn').textContent = 'Configuration Ready - Click Save in Teams';
        }
        
        function saveConfiguration() {
            // Use the ngrok URL directly
            const baseUrl = 'https://macaw-literate-extremely.ngrok-free.app';
            const timestamp = Date.now();
            
            // Get thread ID from meeting context if available
            let threadId = '';
            if (teamsContext && teamsContext.meeting && teamsContext.meeting.id) {
                try {
                    // Decode the base64 meeting ID to get thread ID
                    const decodedMeetingId = atob(teamsContext.meeting.id);
                    // Extract thread ID by removing '0#' prefix and '#0' suffix
                    threadId = decodedMeetingId.replace(/^0#|#0$/g, '');
                    console.log('Extracted thread ID:', threadId);
                } catch (error) {
                    console.error('Failed to decode meeting ID:', error);
                }
            }
            
            const config = {
                entityId: 'linto-bot-' + timestamp,
                contentUrl: baseUrl + '/teams-app-tab' + (threadId ? '?threadId=' + encodeURIComponent(threadId) : ''),
                websiteUrl: baseUrl + '/teams-app-tab' + (threadId ? '?threadId=' + encodeURIComponent(threadId) : ''),
                suggestedDisplayName: 'LinTO Bot'
            };
            
            console.log('Saving config:', config);
            
            // Use promise-based approach as required by Teams v2
            const configPromise = microsoftTeams.pages.config.setConfig(config);
            
            return configPromise
                .then((result) => {
                    console.log('Config saved successfully:', result);
                })
                .catch((error) => {
                    console.error('Failed to save config:', error);
                    throw error;
                });
        }
    </script>
</body>
</html>";
            response.Content = new StringContent(html);
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("text/html");
            
            return response;
        }
        
        /// <summary>
        /// Serves the Teams app tab content (after configuration)
        /// </summary>
        [HttpGet]
        [HttpHead]
        [Route("teams-app-tab")]
        public HttpResponseMessage GetTabContent()
        {
            Serilog.Log.Information($"HTTP {Request.Method} /teams-app-tab");
            
            var response = new HttpResponseMessage(HttpStatusCode.OK);
            // Add Teams-specific headers
            response.Headers.Add("X-Content-Type-Options", "nosniff");
            
            var html = @"<!DOCTYPE html>
<html>
<head>
    <title>LinTO Bot</title>
    <script src='https://res.cdn.office.net/teams-js/2.7.1/js/MicrosoftTeams.min.js'></script>
    <style>
        body { font-family: 'Segoe UI', sans-serif; padding: 20px; }
        .status { color: green; }
        .context { 
            background: #f5f5f5; 
            padding: 10px; 
            border-radius: 4px; 
            margin-top: 20px; 
            font-size: 12px;
        }
    </style>
</head>
<body>
    <h2>LinTO Media Bot</h2>
    <p class='status'>✅ Bot is ready to process audio in this meeting</p>
    <p>The bot will automatically join when invited to process audio streams.</p>
    <div id='context' class='context'>Loading meeting context...</div>
    
    <script>
        // Get thread ID from URL if available
        const urlParams = new URLSearchParams(window.location.search);
        const threadIdFromUrl = urlParams.get('threadId');
        
        // Initialize Teams SDK
        microsoftTeams.app.initialize().then(() => {
            console.log('Teams SDK initialized on tab page');
            
            // Get Teams context to show we're properly loaded
            microsoftTeams.app.getContext().then((context) => {
                console.log('Tab context:', context);
                
                let extractedThreadId = threadIdFromUrl;
                
                // Try to extract thread ID from meeting context if not in URL
                if (!extractedThreadId && context.meeting?.id) {
                    try {
                        const decodedMeetingId = atob(context.meeting.id);
                        extractedThreadId = decodedMeetingId.replace(/^0#|#0$/g, '');
                    } catch (error) {
                        console.error('Failed to decode meeting ID:', error);
                    }
                }
                
                const contextDiv = document.getElementById('context');
                contextDiv.innerHTML = `
                    <strong>Meeting Context:</strong><br>
                    Meeting ID: ${context.meeting?.id || 'N/A'}<br>
                    Thread ID: ${extractedThreadId || 'N/A'}<br>
                    Chat ID: ${context.chat?.id || 'N/A'}<br>
                    User: ${context.user?.displayName || 'N/A'}
                `;
                
                // Store thread ID for bot operations
                if (extractedThreadId) {
                    window.meetingThreadId = extractedThreadId;
                    console.log('Meeting thread ID available:', extractedThreadId);
                }
            }).catch(err => {
                console.error('Failed to get context:', err);
                document.getElementById('context').innerHTML = 'Failed to load meeting context';
            });
        }).catch(err => {
            console.error('Failed to initialize Teams SDK:', err);
        });
    </script>
</body>
</html>";
            
            response.Content = new StringContent(html);
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("text/html");
            return response;
        }
        
        /// <summary>
        /// Handles tab removal
        /// </summary>
        [HttpGet]
        [Route("teams-app-remove")]
        public HttpResponseMessage GetRemovePage()
        {
            Serilog.Log.Information("HTTP GET /teams-app-remove");
            var html = @"<!DOCTYPE html>
<html>
<head>
    <title>Remove LinTO Bot</title>
    <script src='https://res.cdn.office.net/teams-js/2.7.1/js/MicrosoftTeams.min.js'></script>
</head>
<body>
    <h2>Remove LinTO Bot</h2>
    <p>The bot has been removed from this meeting.</p>
    <script>
        microsoftTeams.app.initialize();
    </script>
</body>
</html>";
            
            var response = new HttpResponseMessage(HttpStatusCode.OK);
            response.Content = new StringContent(html);
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("text/html");
            return response;
        }
    }
}