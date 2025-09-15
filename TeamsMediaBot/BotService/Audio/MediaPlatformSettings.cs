using System;
using System.Collections.Generic;
using Microsoft.Extensions.Logging;
using Microsoft.Skype.Bots.Media;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Graph.Communications.Calls.Media;
using System.Security.Cryptography.X509Certificates;

namespace BotService.Audio
{
    /// <summary>
    /// Media Platform settings for ApplicationHostedMedia configuration
    /// Based on Microsoft Graph Communications SDK samples
    /// </summary>
    public class MediaPlatformSettings
    {
        private readonly ILogger _logger;
        
        public MediaPlatformSettings(ILogger logger)
        {
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        /// <summary>
        /// Create MediaPlatformInstanceSettings for ApplicationHostedMediaConfig
        /// </summary>
        /// <param name="mediaEndpointBaseUrl">Base URL for media endpoints</param>
        /// <param name="instanceInternalPort">Internal port for media processing</param>
        /// <param name="instancePublicPort">Public port for media endpoints</param>
        /// <param name="certificateThumbprint">SSL certificate thumbprint</param>
        /// <returns>Configured MediaPlatformInstanceSettings</returns>
        public MediaPlatformInstanceSettings CreateInstanceSettings(
            string mediaEndpointBaseUrl = "https://42b93925edd3.ngrok-free.app",
            int instanceInternalPort = 8445,
            int instancePublicPort = 8445,
            string certificateThumbprint = null)
        {
            try
            {
                _logger.LogInformation("Creating MediaPlatformInstanceSettings");
                _logger.LogInformation("Media Endpoint Base URL: {BaseUrl}", mediaEndpointBaseUrl);
                _logger.LogInformation("Instance Internal Port: {InternalPort}", instanceInternalPort);
                _logger.LogInformation("Instance Public Port: {PublicPort}", instancePublicPort);

                var instanceSettings = new MediaPlatformInstanceSettings
                {
                    // Certificate configuration
                    CertificateThumbprint = certificateThumbprint ?? GetDefaultCertificateThumbprint(),
                    
                    // Media endpoint configuration
                    InstanceInternalPort = instanceInternalPort,
                    InstancePublicPort = instancePublicPort,
                    ServiceFqdn = ExtractFqdnFromUrl(mediaEndpointBaseUrl),
                    
                    // Media processing settings
                    SupportedAudioFormat = AudioFormat.Pcm16K,
                    SupportedVideoFormats = new List<VideoFormat>(),
                    
                    // Disable video for audio-only bot
                    InitializeVideo = false,
                    
                    // Enable audio processing
                    InitializeAudio = true
                };

                _logger.LogInformation("✅ MediaPlatformInstanceSettings created successfully");
                return instanceSettings;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to create MediaPlatformInstanceSettings");
                throw;
            }
        }

        /// <summary>
        /// Create ApplicationHostedMediaConfig for raw media access
        /// </summary>
        /// <returns>Configured ApplicationHostedMediaConfig</returns>
        public Microsoft.Graph.Communications.Calls.Media.ApplicationHostedMediaConfig CreateApplicationHostedMediaConfig()
        {
            try
            {
                _logger.LogInformation("Creating ApplicationHostedMediaConfig for raw audio access");

                var mediaConfig = new Microsoft.Graph.Communications.Calls.Media.ApplicationHostedMediaConfig
                {
                    // Remove media session ID for simplicity - let SDK generate
                    // MediaSessionId = Guid.NewGuid().ToString(),
                };

                _logger.LogInformation("✅ ApplicationHostedMediaConfig created successfully");
                return mediaConfig;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to create ApplicationHostedMediaConfig");
                throw;
            }
        }

        /// <summary>
        /// Create IMediaPlatform for media processing
        /// </summary>
        /// <param name="instanceSettings">Media platform instance settings</param>
        /// <returns>Configured IMediaPlatform</returns>
        public IMediaPlatform CreateMediaPlatform(MediaPlatformInstanceSettings instanceSettings)
        {
            try
            {
                _logger.LogInformation("Creating IMediaPlatform with instance settings");

                // Create media platform
                var mediaPlatform = MediaPlatform.Create(instanceSettings);

                _logger.LogInformation("✅ IMediaPlatform created successfully");
                return mediaPlatform;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to create IMediaPlatform: {Error}", ex.Message);
                
                // Log more details for troubleshooting
                if (ex is TypeInitializationException)
                {
                    _logger.LogError("Type initialization failed - likely missing Windows Media Foundation");
                }
                else if (ex is PlatformNotSupportedException)
                {
                    _logger.LogError("Platform not supported - requires Windows with Media Foundation");
                }
                
                throw;
            }
        }

        /// <summary>
        /// Get default certificate thumbprint from certificate store
        /// </summary>
        private string GetDefaultCertificateThumbprint()
        {
            try
            {
                // For development, we might not have a certificate yet
                // In production, you should have a proper SSL certificate
                
                _logger.LogWarning("No certificate thumbprint specified - using development mode");
                _logger.LogWarning("⚠️ For production deployment, configure a proper SSL certificate");
                
                // Try to find any available certificate
                using (var store = new X509Store(StoreName.My, StoreLocation.LocalMachine))
                {
                    store.Open(OpenFlags.ReadOnly);
                    
                    foreach (var cert in store.Certificates)
                    {
                        if (cert.HasPrivateKey && !cert.Archived)
                        {
                            _logger.LogInformation("Found certificate: {Subject} - Thumbprint: {Thumbprint}", 
                                cert.Subject, cert.Thumbprint);
                            
                            store.Close();
                            return cert.Thumbprint;
                        }
                    }
                    
                    store.Close();
                }
                
                _logger.LogWarning("No suitable certificate found in certificate store");
                return null; // Will cause the MediaPlatform to work without SSL in dev mode
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to get certificate thumbprint");
                return null;
            }
        }

        /// <summary>
        /// Extract FQDN from media endpoint URL
        /// </summary>
        private string ExtractFqdnFromUrl(string url)
        {
            try
            {
                var uri = new Uri(url);
                return uri.Host;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to extract FQDN from URL: {Url}", url);
                return "localhost"; // Fallback
            }
        }

        /// <summary>
        /// Create local media session for the call
        /// </summary>
        /// <param name="mediaPlatform">Media platform instance</param>
        /// <param name="mediaSession">Output media session</param>
        /// <returns>Collection of media sockets</returns>
        public Microsoft.Skype.Bots.Media.ILocalMediaSession CreateLocalMediaSession(IMediaPlatform mediaPlatform)
        {
            try
            {
                _logger.LogInformation("Creating local media session");

                // Create audio socket settings for PCM 16kHz
                var audioSocketSettings = new AudioSocketSettings
                {
                    StreamDirections = StreamDirection.Sendrecv,
                    SupportedAudioFormat = AudioFormat.Pcm16K,
                    CallId = Guid.NewGuid().ToString() // Temporary call ID
                };

                // Create the media session
                var mediaSession = mediaPlatform.CreateMediaSession(
                    audioSocketSettings,
                    videoSocketSettings: null, // Audio-only bot
                    vbssSocketSettings: null   // No screen sharing
                );

                _logger.LogInformation("✅ Local media session created successfully");
                _logger.LogInformation("Audio socket configured: PCM 16kHz, Sendrecv");

                return mediaSession;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to create local media session");
                throw;
            }
        }
    }
}