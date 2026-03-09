using System.Diagnostics;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using TeamsMediaBot.Util;

namespace TeamsMediaBot.Services.Certificate
{
    public class CertificateManager : BackgroundService, ICertificateManager
    {
        private readonly ILogger<CertificateManager> _logger;
        private readonly AppSettings _settings;
        private volatile X509Certificate2? _currentCert;
        private volatile string _currentThumbprint;

        public DateTime? CertificateExpiry => _currentCert?.NotAfter;
        public string CurrentThumbprint => _currentThumbprint;
        public event EventHandler<CertificateRenewedEventArgs>? CertificateRenewed;

        public CertificateManager(ILogger<CertificateManager> logger, IOptions<AppSettings> settings)
        {
            _logger = logger;
            _settings = settings.Value;
            _currentThumbprint = _settings.CertificateThumbprint;
            _currentCert = Utilities.GetCertificateFromStore(_currentThumbprint, _logger);
        }

        public X509Certificate2? GetCurrentCertificate()
        {
            return _currentCert;
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            if (!string.Equals(_settings.SslMode, "letsencrypt", StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation("CertificateManager: SslMode is '{SslMode}', auto-renewal disabled", _settings.SslMode);
                return;
            }

            _logger.LogInformation(
                "CertificateManager: Started with SslMode=letsencrypt, check interval={Hours}h, renewal threshold={Days}d",
                _settings.CertRenewalCheckIntervalHours, _settings.CertRenewalThresholdDays);

            var interval = TimeSpan.FromHours(_settings.CertRenewalCheckIntervalHours);

            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await CheckAndRenewAsync(stoppingToken);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "CertificateManager: Error during certificate check/renewal");
                }

                try
                {
                    await Task.Delay(interval, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        private async Task CheckAndRenewAsync(CancellationToken stoppingToken)
        {
            // Try to detect external renewal (e.g., win-acme scheduled task already ran)
            RefreshCertFromStore();

            if (_currentCert == null)
            {
                _logger.LogWarning("CertificateManager: No current certificate available");
                return;
            }

            var daysUntilExpiry = (_currentCert.NotAfter - DateTime.UtcNow).TotalDays;
            _logger.LogInformation(
                "CertificateManager: Certificate {Thumbprint} expires in {Days:F1} days",
                _currentThumbprint, daysUntilExpiry);

            if (daysUntilExpiry > _settings.CertRenewalThresholdDays)
                return;

            _logger.LogWarning(
                "CertificateManager: Certificate expires in {Days:F1} days (threshold: {Threshold}), attempting renewal",
                daysUntilExpiry, _settings.CertRenewalThresholdDays);

            var success = await RunWinAcmeRenewalAsync(stoppingToken);
            if (!success)
            {
                _logger.LogError("CertificateManager: win-acme renewal failed");
                return;
            }

            // Find the newly issued certificate by FQDN
            var newCert = Utilities.FindCertificateByFqdn(_settings.ServiceDnsName);
            if (newCert == null)
            {
                _logger.LogError("CertificateManager: Could not find renewed certificate for {Fqdn}", _settings.ServiceDnsName);
                return;
            }

            if (string.Equals(newCert.Thumbprint, _currentThumbprint, StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation("CertificateManager: Certificate thumbprint unchanged after renewal");
                return;
            }

            var oldThumbprint = _currentThumbprint;
            _currentThumbprint = newCert.Thumbprint;
            _currentCert = newCert;

            _logger.LogInformation(
                "CertificateManager: Certificate renewed. Old={OldThumbprint}, New={NewThumbprint}, Expiry={Expiry}",
                oldThumbprint, newCert.Thumbprint, newCert.NotAfter.ToString("o"));

            UpdateAppSettingsFile(newCert.Thumbprint);

            CertificateRenewed?.Invoke(this, new CertificateRenewedEventArgs
            {
                OldThumbprint = oldThumbprint,
                NewThumbprint = newCert.Thumbprint,
                NewExpiry = newCert.NotAfter
            });
        }

        private void RefreshCertFromStore()
        {
            try
            {
                // Try loading by current thumbprint
                var store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
                store.Open(OpenFlags.ReadOnly);
                try
                {
                    var certs = store.Certificates.Find(X509FindType.FindByThumbprint, _currentThumbprint, validOnly: false);
                    if (certs.Count == 1 && certs[0].NotAfter > DateTime.UtcNow)
                    {
                        _currentCert = certs[0];
                        return;
                    }
                }
                finally
                {
                    store.Close();
                }

                // Current thumbprint cert is gone or expired — search by FQDN
                var newCert = Utilities.FindCertificateByFqdn(_settings.ServiceDnsName);
                if (newCert != null && !string.Equals(newCert.Thumbprint, _currentThumbprint, StringComparison.OrdinalIgnoreCase))
                {
                    var oldThumbprint = _currentThumbprint;
                    _currentThumbprint = newCert.Thumbprint;
                    _currentCert = newCert;

                    _logger.LogInformation(
                        "CertificateManager: Detected external certificate renewal. Old={OldThumbprint}, New={NewThumbprint}",
                        oldThumbprint, newCert.Thumbprint);

                    UpdateAppSettingsFile(newCert.Thumbprint);

                    CertificateRenewed?.Invoke(this, new CertificateRenewedEventArgs
                    {
                        OldThumbprint = oldThumbprint,
                        NewThumbprint = newCert.Thumbprint,
                        NewExpiry = newCert.NotAfter
                    });
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "CertificateManager: Error refreshing certificate from store");
            }
        }

        private async Task<bool> RunWinAcmeRenewalAsync(CancellationToken stoppingToken)
        {
            var wacsPath = _settings.WinAcmePath;
            if (!File.Exists(wacsPath))
            {
                _logger.LogError("CertificateManager: win-acme not found at {Path}", wacsPath);
                return false;
            }

            var arguments = $"--target manual --host {_settings.ServiceDnsName} " +
                            $"--validation selfhosting --store certificatestore --certificatestore My " +
                            $"--accepttos --emailaddress admin@{_settings.ServiceDnsName}";

            _logger.LogInformation("CertificateManager: Running win-acme: {Path} {Arguments}", wacsPath, arguments);

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = wacsPath,
                    Arguments = arguments,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                using var process = Process.Start(psi);
                if (process == null)
                {
                    _logger.LogError("CertificateManager: Failed to start win-acme process");
                    return false;
                }

                var stdout = await process.StandardOutput.ReadToEndAsync(stoppingToken);
                var stderr = await process.StandardError.ReadToEndAsync(stoppingToken);
                await process.WaitForExitAsync(stoppingToken);

                _logger.LogInformation("CertificateManager: win-acme exited with code {ExitCode}", process.ExitCode);

                if (!string.IsNullOrWhiteSpace(stdout))
                    _logger.LogInformation("CertificateManager: win-acme stdout: {Stdout}", stdout);
                if (!string.IsNullOrWhiteSpace(stderr))
                    _logger.LogWarning("CertificateManager: win-acme stderr: {Stderr}", stderr);

                return process.ExitCode == 0;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "CertificateManager: Error running win-acme");
                return false;
            }
        }

        private void UpdateAppSettingsFile(string newThumbprint)
        {
            try
            {
                var settingsPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "appsettings.Production.json");
                if (!File.Exists(settingsPath))
                {
                    _logger.LogWarning("CertificateManager: {Path} not found, skipping thumbprint update", settingsPath);
                    return;
                }

                var json = File.ReadAllText(settingsPath);
                var doc = JsonNode.Parse(json);
                if (doc == null)
                {
                    _logger.LogWarning("CertificateManager: Failed to parse {Path}", settingsPath);
                    return;
                }

                var appSettingsNode = doc["AppSettings"];
                if (appSettingsNode != null)
                {
                    appSettingsNode["CertificateThumbprint"] = newThumbprint;
                }

                var options = new JsonSerializerOptions { WriteIndented = true };
                File.WriteAllText(settingsPath, doc.ToJsonString(options));

                _logger.LogInformation("CertificateManager: Updated CertificateThumbprint in {Path}", settingsPath);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "CertificateManager: Failed to update appsettings file");
            }
        }
    }
}
