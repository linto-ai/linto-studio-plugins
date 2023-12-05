#!/bin/bash

# Create the CSV file and write the headers
echo "Dependency name,Version,Licence,Copyright,Link to repo" > LICENCE-REPORT.csv

# Function to extract information from the license-checker output
extract_info() {
    local dep=$1
    local info=$2
    local name=$(echo $dep | cut -d '@' -f 1)
    local version=$(echo $dep | cut -d '@' -f 2)
    local licenses=$(echo $info | jq -r .licenses)
    local copyright=$(echo $info | jq -r .publisher)
    local repo=$(echo $info | jq -r .repository)
    echo "$name,$version,$licenses,$copyright,$repo" >> LICENCE-REPORT.csv
}

# Run the license-checker command in the current directory
output=$(npx license-checker-rseidelsohn --json --direct 0)
for dep in $(echo $output | jq -r 'keys[]'); do
    info=$(echo $output | jq -r .\"$dep\")
    # if name starts with live-transcription, don't include it
    if [[ $dep == live-transcription* ]]; then
           continue
    fi
    extract_info $dep "$info"
done

for dir in Delivery front-end lib migration Scheduler Session-API Transcriber; do
    echo "Checking $dir"
    output=$(cd $dir && npx license-checker-rseidelsohn --json --direct 0)
    for dep in $(echo $output | jq -r 'keys[]'); do
        info=$(echo $output | jq -r .\"$dep\")
        # if name starts with live-transcription, don't include it
        if [[ $dep == live-transcription* ]]; then
            continue
        fi
        extract_info $dep "$info"
    done
done