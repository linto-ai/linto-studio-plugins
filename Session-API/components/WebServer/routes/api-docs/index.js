const debug = require('debug')('session-api:router:api-docs')
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger/swagger.json');
const swaggerJsdoc = require("swagger-jsdoc")

module.exports = (webserver) => {

    swaggerDocument.definition.servers = [{"url": process.env.SESSION_API_HOST + ":" + process.env.SESSION_API_WEBSERVER_HTTP_PORT + "/v1"}]
    swaggerDocument.definition.components = {
        ...swaggerDocument.definition.components,
        ...require('./swagger/components/index.js')
    }

    swaggerDocument.definition.components.schemas = {
        ...swaggerDocument.definition.components.schemas,
        ...require(`./swagger/components/schemas/index.js`)
    }
    swaggerDocument.definition.paths = require('./swagger/index.js')

    swaggerDocument.apis = ["./swagger/"]

    //serve swagger
    webserver.express.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerJsdoc(swaggerDocument)));
}

