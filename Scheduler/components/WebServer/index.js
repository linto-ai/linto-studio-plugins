const debug = require('debug')(`scheduler:webserver`)
const { Component } = require("live-srt-lib")
const cors = require('cors');
const express = require('express')
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
        this.express.use(cors());
        this.httpServer = this.express.listen(process.env.SCHEDULER_WEBSERVER_HTTP_PORT, "0.0.0.0", (err) => {
            debug(`Listening on: ${process.env.SCHEDULER_WEBSERVER_HTTP_PORT}`)
            if (err) throw (err)
        })

        require('./routes/router.js')(this) // Loads all defined routes
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
