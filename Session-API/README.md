# Session Manager API

The Session-API component provides a REST API for managing sessions and transcriber profiles. The Session-API does not directly insert data into the database. For instance, when creating a session, the Session-API sends the payload to the Scheduler, which is responsible for updating the database.

It is not relevant to document the exposed routes in this README because a Swagger documentation is available to document the API. This documentation can be accessed via the URL: http://localhost/sessionapi/api-docs/

This API allows for the following actions:

- CRUD (Create, Read, Update, Delete) on transcriber profiles
- Checking the system status with a health check
- CRUD for sessions
- Retrieval of active and completed sessions
- Starting and stopping a session
