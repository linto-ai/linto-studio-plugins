const { Component, logger } = require('live-srt-lib');
const net = require('net');

class Healthcheck extends Component {
    constructor(app) {
        super(app);
        this.id = this.constructor.name;
        this.init();
        this.setupHealthCheckServer();
    }

    setupHealthCheckServer() {
        this.healthCheckServer = net.createServer((socket) => {
            socket.on('error', (error) => {
                logger.error('Socket error:', error);
            });
            socket.end('OK\n');
        });

        const port = parseInt(process.env.STREAMING_HEALTHCHECK_TCP, 10);
        this.healthCheckServer.listen(port, () => {
            logger.debug(`HealthCheck server listening on port ${port}`);
        });
    }
}

module.exports = app => new Healthcheck(app);
