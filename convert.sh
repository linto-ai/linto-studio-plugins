#!/bin/bash

for file in ./*.wav; do
  ffmpeg -i "$file" -acodec libmp3lame -ac 1 -ar 16000 "${file%.wav}.mp3"
done