using System.Security.Cryptography.X509Certificates;

namespace TeamsMediaBot.Services.Certificate
{
    public interface ICertificateManager
    {
        DateTime? CertificateExpiry { get; }
        string CurrentThumbprint { get; }
        X509Certificate2? GetCurrentCertificate();
        event EventHandler<CertificateRenewedEventArgs>? CertificateRenewed;
    }

    public class CertificateRenewedEventArgs : EventArgs
    {
        public required string OldThumbprint { get; init; }
        public required string NewThumbprint { get; init; }
        public DateTime NewExpiry { get; init; }
    }
}
