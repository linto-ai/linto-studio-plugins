# Client front end application

The front-end provides a web interface that allows for intuitive use of sessions, channels, and transcriptions.

The front-end offers two different pages: the admin page and the user page.

## User page

The user page offers the following functionalities:

- Access to the session passed as a URL parameter
- Access to the different channels of a session
- For each channel, view the transcriptions already carried out and real-time transcriptions.
- Export options in DOC, TXT, SRT, VTT formats

## Admin page

The admin page offers the functionalities of the user page but with additional features:

- Ability to access all started and stopped sessions
- Ability to generate a link to the user page of a session


## How it works

### Build

To generate these pages, Parcel is used. It allows for the creation of a static HTML page through compilation. Then the HTML is served via an nginx server.

### Real-time subtile transfer

In order to transfer subtitles in real-time, the Socket.io library is used. The Socket.io server is integrated into the Delivery component. When an active session is selected, the frontend subscribes to the corresponding socket.io room and starts receiving real-time transcriptions.

### Subtitle pre-loading

When selecting a session, a request is made to the Session-API to retrieve the already recorded closed captions. This allows for preloading the subtitles.
