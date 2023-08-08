const debug = require('debug')(`session-api:webserver`)
const { Component } = require("live-srt-lib")
const path = require('path')
const cors = require('cors');
const express = require('express')
const Session = require('express-session')
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')


class WebServer extends Component {
    constructor(app) {
        super(app)
        this.id = this.constructor.name
        //sessions (created by API call) that are waiting for an acknowledgment from the scheduler
        this.express = app
        this.express = express()
        this.express.set('etag', false)
        this.express.set('trust proxy', true)
        this.express.use(bodyParser.json())
        this.express.use(bodyParser.urlencoded({
            extended: false
        }))
        this.express.use(cookieParser())
        this.express.use(cors());
        // HTTP session, nothing to do with subtitling sessions
        let sessionConfig = {
            resave: false,
            saveUninitialized: true,
            secret: require('crypto').randomBytes(64).toString('hex'),
            cookie: {
                secure: false,
                maxAge: 604800 // 7 days
            }
        }
        this.session = Session(sessionConfig)
        this.express.use(this.session)
        this.httpServer = this.express.listen(process.env.SESSION_API_WEBSERVER_HTTP_PORT, "0.0.0.0", (err) => {
            debug(`Listening on : ${process.env.SESSION_API_WEBSERVER_HTTP_PORT}`)
            if (err) throw (err)
        })

        require('./routes/router.js')(this) // Loads all defined routes

        //Static files in public folder
        this.express.use('/', express.static(path.resolve(__dirname, './public')))
        this.express.use((req, res, next) => {
            res.status(404)
            res.end()
        })

        //final "catch all" 4 parameters function 500 Error
        this.express.use((err, req, res, next) => {
            console.error(err)
            res.status(500)
            res.end()
        })

        return this.init()
    }

    waitAckSessionCreation(sessionId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Session creation timeout`));
                this.removeListener(`session_ack_creation`, onSessionAckCreation);
                this.removeListener(`session_reject_creation`, onSessionRejectCreation);
            }, 10000);

            const onSessionAckCreation = (ackSessionId) => {
                if (ackSessionId === sessionId) {
                    clearTimeout(timeout);
                    resolve(sessionId);
                    this.removeListener(`session_ack_creation`, onSessionAckCreation);
                    this.removeListener(`session_reject_creation`, onSessionRejectCreation);
                }
            };

            const onSessionRejectCreation = (payload) => {
                payload = payload
                if (payload.sessionId === sessionId) {
                    clearTimeout(timeout);
                    reject(new Error(payload.error));
                    this.removeListener(`session_ack_creation`, onSessionAckCreation);
                    this.removeListener(`session_reject_creation`, onSessionRejectCreation);
                }
            };

            this.on(`session_ack_creation`, onSessionAckCreation);
            this.on(`session_reject_creation`, onSessionRejectCreation);
        });
    }
}

module.exports = app => new WebServer(app)