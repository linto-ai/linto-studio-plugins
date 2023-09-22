#!/bin/bash
set -e

# build the front-end
cd /usr/src/app/front-end && npm run build
cp -r /usr/src/app/front-end/dist/* /var/www/html/

# update nginx conf file
envsubst '${FRONT_END_PORT}' < /etc/nginx/sites-enabled/frontend.nginx.conf | sponge /etc/nginx/sites-enabled/frontend.nginx.conf
htpasswd -b -c /var/www/html/htpasswd $FRONT_END_ADMIN_USERNAME $FRONT_END_ADMIN_PASSWORD

echo "RUNNING : $1"
eval "$1"
