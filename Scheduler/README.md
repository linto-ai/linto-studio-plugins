# Scheduler

The Scheduler is the orchestrator of the system that links the various services. The Scheduler can be accessed via a REST API specifically exposed for the Session-API (CRUD of sessions). Apart from that, communication between the Scheduler and the other services occurs via the MQTT broker.


The Scheduler has several responsibilities:

- It is responsible for enrolling transcribers when a new session is created. It sends the enrollment request to the transcriber.
- It manages the synchronization of the database with the actual state of the resources. With each event related to a transcriber, the sessions and channels are synchronized.
- It also plays an important role in the maintenance and operational continuity of the system. For instance, if a transcriber crashes, the Scheduler ensures that the affected channel can enroll another transcriber if possible. If the entire system crashes and is restarted, the Scheduler will try as much as possible to re-establish all transcriber assignments and automatically restart the transcribers associated with the started sessions.
