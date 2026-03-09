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
        public CertificateRenewedEventArgs(string oldThumbprint, string newThumbprint)
        {
            OldThumbprint = oldThumbprint;
            NewThumbprint = newThumbprint;
        }

        public string OldThumbprint { get; }
        public string NewThumbprint { get; }
        public DateTime NewExpiry { get; init; }
    }
}
