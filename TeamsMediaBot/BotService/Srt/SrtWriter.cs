using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace BotService.Srt
{
    public interface ISrtWriter : IAsyncDisposable
    {
        Task SendAsync(ReadOnlyMemory<byte> frame, CancellationToken cancellationToken);
        void Configure(string host, int port, int latency, string streamId);
    }

    public sealed class SrtWriter : ISrtWriter
    {
        private readonly ILogger<SrtWriter> _logger;
        private IntPtr _socket;
        private string _hostname;
        private int _port;
        private int _latency;
        private string _streamId;

        public SrtWriter(ILogger<SrtWriter> logger)
        {
            _logger = logger;
            _hostname = Environment.GetEnvironmentVariable("SRT_HOST") ?? "localhost";
            _port = int.TryParse(Environment.GetEnvironmentVariable("SRT_PORT"), out var p) ? p : 9000;
            _latency = int.TryParse(Environment.GetEnvironmentVariable("SRT_LATENCY"), out var l) ? l : 120;
            _streamId = Environment.GetEnvironmentVariable("SRT_STREAM_ID") ?? string.Empty;
        }

        public SrtWriter(ILogger<SrtWriter> logger, string host, int port, int latency, string streamId)
            : this(logger)
        {
            Configure(host, port, latency, streamId);
        }

        public void Configure(string host, int port, int latency, string streamId)
        {
            _hostname = host;
            _port = port;
            _latency = latency;
            _streamId = streamId;
        }

        public async Task SendAsync(ReadOnlyMemory<byte> frame, CancellationToken cancellationToken)
        {
            if (_socket == IntPtr.Zero)
            {
                await ConnectAsync(cancellationToken);
            }
            // P/Invoke to srt_send
            var size = SrtSend(_socket, frame.Span, frame.Length);
            if (size < 0)
            {
                _logger.LogWarning("srt_send failed: {Error}", size);
            }
        }

        private async Task ConnectAsync(CancellationToken cancellationToken)
        {
            // Minimal example without error handling.
            SrtStartup();
            _socket = SrtCreateSocket();
            var addr = CreateSockAddr(_hostname, _port);
            var res = SrtConnect(_socket, ref addr);
            if (res != 0)
            {
                _logger.LogError("SRT connect failed: {Error}", res);
                throw new InvalidOperationException("SRT connect failed");
            }
            await Task.CompletedTask;
        }

        public async ValueTask DisposeAsync()
        {
            if (_socket != IntPtr.Zero)
            {
                SrtClose(_socket);
                _socket = IntPtr.Zero;
            }
            await Task.CompletedTask;
        }

        #region PInvoke
        [DllImport("srt")]
        private static extern int srt_startup();

        [DllImport("srt")]
        private static extern int srt_socket(int af, int type, int protocol);

        [DllImport("srt")]
        private static extern int srt_connect(int sock, ref SockAddr addr);

        [DllImport("srt")]
        private static extern int srt_send(int sock, ReadOnlySpan<byte> buf, int len);

        [DllImport("srt")]
        private static extern int srt_close(int sock);

        private static void SrtStartup() => srt_startup();
        private static IntPtr SrtCreateSocket() => (IntPtr)srt_socket(2, 1, 0);
        private static int SrtConnect(IntPtr sock, ref SockAddr addr) => srt_connect(sock.ToInt32(), ref addr);
        private static int SrtSend(IntPtr sock, ReadOnlySpan<byte> buf, int len) => srt_send(sock.ToInt32(), buf, len);
        private static void SrtClose(IntPtr sock) => srt_close(sock.ToInt32());

        [StructLayout(LayoutKind.Sequential)]
        private struct SockAddr
        {
            public ushort sin_family;
            public ushort sin_port;
            public uint sin_addr;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)]
            public byte[] sin_zero;
        }

        private static SockAddr CreateSockAddr(string host, int port)
        {
            var addr = new SockAddr
            {
                sin_family = 2,
                sin_port = htons((ushort)port),
                sin_addr = inet_addr(host),
                sin_zero = new byte[8]
            };
            return addr;
        }

        [DllImport("c")] private static extern ushort htons(ushort hostshort);
        [DllImport("c")] private static extern uint inet_addr(string cp);
        #endregion
    }
}
