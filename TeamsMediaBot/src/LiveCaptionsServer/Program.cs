using System.Security.Cryptography.X509Certificates;
using LiveCaptionsServer.Hubs;
using LiveCaptionsServer.Services;
using LiveCaptionsServer.Settings;

namespace LiveCaptionsServer;

/// <summary>
/// Live Captions Server - Standalone SignalR server for Teams Live Captions.
///
/// This server:
/// - Listens on port 443 with HTTPS (SSL certificate from Windows store)
/// - Serves static files for the Teams side panel React app
/// - Hosts a SignalR hub for real-time caption streaming
/// - Connects to MQTT broker to receive transcriptions
/// - Broadcasts transcriptions to connected Teams clients
/// </summary>
public static class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        // Load configuration from environment variables (for Docker/deployment)
        builder.Configuration.AddEnvironmentVariables(prefix: "CaptionsServer__");

        // Bind and validate settings
        var settingsSection = builder.Configuration.GetSection(CaptionsServerSettings.SectionName);
        var settings = settingsSection.Get<CaptionsServerSettings>() ?? new CaptionsServerSettings();

        builder.Services
            .AddOptions<CaptionsServerSettings>()
            .BindConfiguration(CaptionsServerSettings.SectionName)
            .ValidateDataAnnotations()
            .ValidateOnStart();

        // Configure Kestrel to listen on the configured HTTPS port
        builder.WebHost.ConfigureKestrel(serverOptions =>
        {
            serverOptions.ListenAnyIP(settings.Port, listenOptions =>
            {
                if (!string.IsNullOrWhiteSpace(settings.CertificateThumbprint))
                {
                    var certificate = GetCertificateFromStore(settings.CertificateThumbprint);
                    if (certificate != null)
                    {
                        listenOptions.UseHttps(certificate);
                        Console.WriteLine($"[LiveCaptionsServer] Using certificate: {certificate.Subject}");
                    }
                    else
                    {
                        Console.WriteLine($"[LiveCaptionsServer] WARNING: Certificate not found: {settings.CertificateThumbprint}");
                        Console.WriteLine("[LiveCaptionsServer] Falling back to development certificate");
                        listenOptions.UseHttps();
                    }
                }
                else
                {
                    Console.WriteLine("[LiveCaptionsServer] No certificate thumbprint configured, using development certificate");
                    listenOptions.UseHttps();
                }
            });
        });

        // Configure logging
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole();
        builder.Logging.SetMinimumLevel(LogLevel.Information);

        // Add SignalR with JSON protocol
        builder.Services.AddSignalR(options =>
        {
            options.EnableDetailedErrors = builder.Environment.IsDevelopment();
            options.KeepAliveInterval = TimeSpan.FromSeconds(15);
            options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        });

        // Add CORS for Teams embedding
        // Teams requires specific CORS settings for SignalR to work
        builder.Services.AddCors(options =>
        {
            options.AddPolicy("TeamsCorsPolicy", policy =>
            {
                policy
                    .AllowAnyHeader()
                    .AllowAnyMethod()
                    .AllowCredentials()
                    .SetIsOriginAllowed(_ => true); // Allow any origin for Teams embedding
            });
        });

        // Add session mapping cache (singleton to share state across requests)
        builder.Services.AddSingleton<ISessionMappingCache, SessionMappingCache>();

        // Add controllers for the REST API
        builder.Services.AddControllers();

        // Add the MQTT transcription background service
        builder.Services.AddHostedService<MqttTranscriptionService>();

        var app = builder.Build();

        // Log startup information
        var logger = app.Services.GetRequiredService<ILogger<MqttTranscriptionService>>();
        logger.LogInformation("=================================================");
        logger.LogInformation("  Live Captions Server starting");
        logger.LogInformation("  Port: {Port}", settings.Port);
        logger.LogInformation("  MQTT Broker: {Host}:{MqttPort}", settings.BrokerHost, settings.BrokerPort);
        logger.LogInformation("=================================================");

        // Enable CORS (must be before other middleware)
        app.UseCors("TeamsCorsPolicy");

        // Serve static files from wwwroot
        // These are the React app files for the Teams side panel
        app.UseDefaultFiles(); // Enables index.html as default
        app.UseStaticFiles();

        // Map the SignalR hub
        // Teams clients connect to: wss://domain:443/hubs/captions
        app.MapHub<CaptionsHub>("/hubs/captions");

        // Map REST API controllers
        // API endpoints: /api/captions/session, /api/captions/sessions
        app.MapControllers();

        // Health check endpoint
        app.MapGet("/health", () => Results.Ok(new
        {
            status = "healthy",
            timestamp = DateTime.UtcNow,
            service = "LiveCaptionsServer"
        }));

        // Run the application
        await app.RunAsync();
    }

    /// <summary>
    /// Retrieves an X.509 certificate from the Windows Certificate Store by thumbprint.
    /// Searches both LocalMachine and CurrentUser stores.
    /// </summary>
    /// <param name="thumbprint">The certificate thumbprint (case-insensitive, spaces allowed).</param>
    /// <returns>The certificate if found, null otherwise.</returns>
    private static X509Certificate2? GetCertificateFromStore(string thumbprint)
    {
        // Normalize thumbprint: remove spaces and convert to uppercase
        var normalizedThumbprint = thumbprint
            .Replace(" ", string.Empty)
            .Replace("-", string.Empty)
            .ToUpperInvariant();

        // Search in LocalMachine\My store first (typical for server certificates)
        var certificate = FindCertificate(StoreLocation.LocalMachine, normalizedThumbprint);
        if (certificate != null)
        {
            return certificate;
        }

        // Fallback to CurrentUser\My store
        certificate = FindCertificate(StoreLocation.CurrentUser, normalizedThumbprint);
        return certificate;
    }

    /// <summary>
    /// Finds a certificate in the specified store location.
    /// </summary>
    private static X509Certificate2? FindCertificate(StoreLocation storeLocation, string thumbprint)
    {
        using var store = new X509Store(StoreName.My, storeLocation);
        try
        {
            store.Open(OpenFlags.ReadOnly);

            var certificates = store.Certificates.Find(
                X509FindType.FindByThumbprint,
                thumbprint,
                validOnly: false);

            if (certificates.Count > 0)
            {
                Console.WriteLine($"[LiveCaptionsServer] Found certificate in {storeLocation}\\My");
                return certificates[0];
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[LiveCaptionsServer] Error accessing certificate store {storeLocation}: {ex.Message}");
        }

        return null;
    }
}
