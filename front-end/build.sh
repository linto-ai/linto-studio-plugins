#!/bin/bash

echo "Public url: ${FRONT_END_BASE_PATH:-"/"}"
npx parcel build ./*.html --public-url=${FRONT_END_BASE_PATH:-"/"}
