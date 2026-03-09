using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.Logging;

namespace TeamsMediaBot.Util
{
    /// <summary>
    /// The utility class.
    /// </summary>
    internal static class Utilities
    {
        /// <summary>
        /// Helper to search the certificate store by its thumbprint.
        /// </summary>
        /// <returns>Certificate if found.</returns>
        /// <exception cref="Exception">No certificate with thumbprint {CertificateThumbprint} was found in the machine store.</exception>
        public static X509Certificate2 GetCertificateFromStore(string certificateThumbprint, ILogger? logger = null)
        {
            X509Store store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
            store.Open(OpenFlags.ReadOnly);
            try
            {
                X509Certificate2Collection certs = store.Certificates.Find(X509FindType.FindByThumbprint, certificateThumbprint, validOnly: false);

                if (certs.Count != 1)
                {
                    throw new Exception($"No certificate with thumbprint {certificateThumbprint} was found in the machine store.");
                }

                var cert = certs[0];
                ValidateCertificateExpiry(cert, logger);
                return cert;
            }
            finally
            {
                store.Close();
            }
        }

        /// <summary>
        /// Validates that a certificate is not expired and logs its details.
        /// </summary>
        /// <param name="cert">The certificate to validate.</param>
        /// <param name="logger">Optional logger for certificate info.</param>
        /// <param name="warningThresholdDays">Days before expiry to trigger a warning.</param>
        /// <exception cref="InvalidOperationException">Thrown when the certificate is expired or not yet valid.</exception>
        public static void ValidateCertificateExpiry(X509Certificate2 cert, ILogger? logger = null, int warningThresholdDays = 7)
        {
            var now = DateTime.UtcNow;
            var daysRemaining = (cert.NotAfter - now).TotalDays;

            logger?.LogInformation(
                "Certificate info: Thumbprint={Thumbprint}, Subject={Subject}, NotBefore={NotBefore}, NotAfter={NotAfter}, DaysRemaining={DaysRemaining:F1}",
                cert.Thumbprint, cert.Subject, cert.NotBefore.ToString("o"), cert.NotAfter.ToString("o"), daysRemaining);

            if (now > cert.NotAfter)
            {
                var daysSinceExpiry = (now - cert.NotAfter).TotalDays;
                var message = $"Certificate {cert.Thumbprint} expired on {cert.NotAfter:o} ({daysSinceExpiry:F1} days ago). " +
                              $"The service cannot start with an expired certificate.";
                logger?.LogError("{Message}", message);
                throw new InvalidOperationException(message);
            }

            if (now < cert.NotBefore)
            {
                var message = $"Certificate {cert.Thumbprint} is not yet valid. NotBefore={cert.NotBefore:o}, current time={now:o}.";
                logger?.LogError("{Message}", message);
                throw new InvalidOperationException(message);
            }

            if (daysRemaining <= warningThresholdDays)
            {
                logger?.LogWarning(
                    "Certificate {Thumbprint} expires in {DaysRemaining:F1} days (on {NotAfter}). Renewal recommended.",
                    cert.Thumbprint, daysRemaining, cert.NotAfter.ToString("o"));
            }
        }

        /// <summary>
        /// Finds the best valid certificate in the store matching the given FQDN.
        /// Returns the certificate with the latest NotAfter date.
        /// </summary>
        /// <param name="fqdn">The fully qualified domain name to match.</param>
        /// <returns>The matching certificate, or null if none found.</returns>
        public static X509Certificate2? FindCertificateByFqdn(string fqdn)
        {
            var now = DateTime.UtcNow;
            X509Store store = new X509Store(StoreName.My, StoreLocation.LocalMachine);
            store.Open(OpenFlags.ReadOnly);
            try
            {
                X509Certificate2? best = null;
                foreach (var cert in store.Certificates)
                {
                    if (cert.NotAfter <= now || cert.NotBefore > now)
                        continue;

                    var dnsName = cert.GetNameInfo(X509NameType.DnsName, forIssuer: false);
                    var subjectContainsCn = cert.Subject.Contains($"CN={fqdn}", StringComparison.OrdinalIgnoreCase);

                    if (string.Equals(dnsName, fqdn, StringComparison.OrdinalIgnoreCase) || subjectContainsCn)
                    {
                        if (best == null || cert.NotAfter > best.NotAfter)
                        {
                            best = cert;
                        }
                    }
                }
                return best;
            }
            finally
            {
                store.Close();
            }
        }
    }
}
