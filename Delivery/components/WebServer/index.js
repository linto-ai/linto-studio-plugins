const debug = require('debug')(`delivery:webserver`)
const { Component } = require("live-srt-lib")
const path = require('path')
const cors = require('cors');
const express = require('express')
const session = require('express-session');
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')

class WebServer extends Component {
    constructor(app) {
        super(app)
        this.id = this.constructor.name
        this.express = express()
        this.express.set('etag', false)
        this.express.set('trust proxy', true)
        this.express.use(bodyParser.json())
        this.express.use(bodyParser.urlencoded({
            extended: false
        }))
        this.express.use(cookieParser())

        // Handle CORS for multiple domains
        const allowedDomains = process.env.ALLOWED_DOMAINS ? process.env.ALLOWED_DOMAINS.split(',') : [];
        this.express.use(cors({
            origin: function (origin, callback) {
                if (!origin || allowedDomains.indexOf(origin) !== -1) {
                    callback(null, true)
                } else {
                    callback(new Error('Not allowed by CORS'))
                }
            }
        }));

        const sessionMiddleware = session({
            secret: process.env.SESSION_SECRET || "defaultsecret",
            resave: false,
            saveUninitialized: true,
            cookie: {
                secure: false,
                maxAge: 604800 // 7 days
            }
        });
        this.httpServer = this.express.listen(process.env.DELIVERY_WEBSERVER_HTTP_PORT, "0.0.0.0", (err) => {
            debug(`Listening on: ${process.env.DELIVERY_WEBSERVER_HTTP_PORT}`)
            if (err) throw (err)
        })

        require('./routes/router.js')(this) // Loads all defined routes
        this.express.use('/', express.static(path.resolve(__dirname, './public')))
        this.express.use((req, res, next) => {
            res.status(404)
            res.end()
        })

        this.express.use((err, req, res, next) => {
            console.error(err)
            res.status(500)
            res.end()
        })

        return this.init()
    }
}

module.exports = app => new WebServer(app)