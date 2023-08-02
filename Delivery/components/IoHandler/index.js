const debug = require('debug')('delivery:socketio')
const path = require('path')
const { Component } = require("live-srt-lib");
const socketIO = require('socket.io');

class IoHandler extends Component {
    constructor(app) {
        super(app, "WebServer") // Relies on a WebServer component to be registrated
        this.id = this.constructor.name
        this.app = app

        // TODO: cors should be updated to be configurable with an envvar
        this.io = socketIO(this.app.components["WebServer"].httpServer, {
            cors: {
              origin: "http://localhost:8003",
              methods: ["GET", "POST"]
            }
        })

        this.io.on("connection", (socket) => {
            debug(`New client connected : ${socket.id}`)

            socket.on('join_room', function(channel) {
                debug(`Client ${socket.id} joins room ${channel}`)
                socket.join(channel);
            });

            socket.on('leave_room', function(channel) {
                debug(`Client ${socket.id} leaves room ${channel}`)
                socket.leave(channel);
            });

            socket.on("disconnect", () => {
                debug(`Client ${socket.id} disconnected`)
            })
        })

        return this.init()
    }

    //broadcasts to connected sockets
    notify(transcriberId, action, transcription) {
        if (this.io.sockets.adapter.rooms.has(transcriberId)) {
            this.io.to(transcriberId).emit(action, transcription)
        }
    }
}

module.exports = (app) => new IoHandler(app)
