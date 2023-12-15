# Migration component

This component allows for the initialization of the database and then updates the schema if necessary without breaking production.

The file `config/config.js` contains the configuration for connecting to the database.

The migrations folder contains migration files that are executed in alphabetical and sequential order. A migration file must export two functions: `up` and `down`. In practice, `down` is seldom used as it allows for undoing the changes made, which only occurs when a regression is realized in production due to the migration.

It is important to note that the result of the migrations must be synchronized with the model defined in `lib/model/model.js`.
