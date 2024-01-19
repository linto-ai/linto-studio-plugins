#!/bin/bash

# Create the notice.txt file and write the headers
echo "Live Transcription Open Source Toolbox" > notice.txt
echo "version: 1.0" >> notice.txt
echo "========================================================================================" >> notice.txt
echo "" >> notice.txt
echo "Copyright (C) European Union 2023" >> notice.txt
echo "" >> notice.txt
echo "This program is free software: you can redistribute it and/or modify it under the terms of the European Union Public Licence, either version 1.2 of the License, or (at your option) any later version." >> notice.txt
echo "You may not use this work except in compliance with the Licence." >> notice.txt
echo "" >> notice.txt
echo "You may obtain a copy of the Licence at: https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12" >> notice.txt
echo "" >> notice.txt
echo "Unless required by applicable law or agreed to in writing, software distributed under the Licence is distributed on an \"AS IS\" basis, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied." >> notice.txt
echo "" >> notice.txt
echo "See the Licence for the specific language governing permissions and limitations under the Licence." >> notice.txt
echo "" >> notice.txt
echo "----------------" >> notice.txt
echo "" >> notice.txt
echo "This product uses software developed by third parties:" >> notice.txt
echo "" >> notice.txt
echo "========================================================================================" >> notice.txt

# Function to extract information from the license-checker output
extract_info() {
    local dep=$1
    local info=$2
    local name=$(echo $dep | cut -d '@' -f 1)
    local version=$(echo $dep | cut -d '@' -f 2)
    local licenses=$(echo $info | jq -r .licenses)
    local copyright=$(echo $info | jq -r .publisher)
    local repo=$(echo $info | jq -r .repository)
    local github_repo=$(echo $repo | sed -n 's|https://github.com/||p')
    # Write the copyright notice to the file
    echo "$name" >> notice.txt
    echo "----------------" >> notice.txt
    echo "$repo" >> notice.txt
    echo "" >> notice.txt
    echo "$licenses License" >> notice.txt
    echo "" >> notice.txt
    # Check if copyright is not null
    if [ "$copyright" != "null" ]; then
        echo "Copyright (c) $copyright" >> notice.txt
        echo "" >> notice.txt
    fi
    # Fetch the LICENSE file from GitHub
    if [ "$github_repo" != "" ]; then
        for branch in master main; do
            for license_file in LICENSE LICENSE.txt LICENSE.md LICENCE LICENCE.txt LICENCE.md; do
                license_text=$(curl -s "https://raw.githubusercontent.com/$github_repo/$branch/$license_file")
                if [ "$license_text" != "404: Not Found" ]; then
                    echo "$license_text" >> notice.txt
                    break 2
                fi
            done
        done
    fi
    echo "" >> notice.txt
    echo "========================================================================================" >> notice.txt
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