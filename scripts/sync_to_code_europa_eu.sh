#!/bin/bash
apk add --no-cache git rsync
rm -rf speech-to-text-public
git clone "https://ursumih:${pat_codeeuropaeu}@code.europa.eu/speech_recognition/speech-to-text.git" speech-to-text-public
rsync -av --exclude='.gitlab-ci.yml' --exclude='speech-to-text-public' --exclude='.git' . speech-to-text-public/
cd speech-to-text-public/
git add . 
today_date=$(date +%d-%m-%Y)
hour_date=$(date +%H:%m:%S)
git config --global user.email "mihai-valentin.ursu@ext.ec.europa.eu"
git config --global user.name "Publish Public Version"
git commit -am "Release to public on date ${today_date} at hour ${hour_date}"
git push --force-with-lease