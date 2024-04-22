#!/bin/bash
set -e 
registry=${CI_REGISTRY}
REGISTRY_IMAGE_PREFIX=${CI_REGISTRY_IMAGE}
declare -a components=("Delivery" "front-end" "migration" "Scheduler" "Session-API" "Transcriber")
if [[ $registry == "registry.fpfis.eu" ]]; then
echo "Pushing to Nexus also"
NEXUS_REPO="scicspeechservices-docker.devops.tech.ec.europa.eu"
for COMPONENT in "${components[@]}"
do
echo "Building docker image for $COMPONENT"
COMPONENT_TAG=$(echo "$COMPONENT" | awk '{print tolower($0)}' | tr -d '-')
docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
if [[ $COMPONENT == "front-end" || $COMPONENT == "Transcriber" ]]; then
docker build -t "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$CI_COMMIT_SHORT_SHA" -t "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$TAG" -f "$COMPONENT/Dockerfile" .
else
docker build -t "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$CI_COMMIT_SHORT_SHA" -t "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$TAG" --build-arg default_image="$REGISTRY_IMAGE_PREFIX/node:20-alpine" -f "$COMPONENT/Dockerfile" .
fi
docker push "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$CI_COMMIT_SHORT_SHA"
docker push "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$TAG"
# login and push to nexus repo
echo "$NEXUS_PASSWORD" | docker login $NEXUS_REPO --username $NEXUS_USER  --password-stdin 
docker tag  "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$TAG" "$NEXUS_REPO/$COMPONENT_TAG:$TAG"
docker push "$NEXUS_REPO/$COMPONENT_TAG:$TAG"
echo "END Building docker image for ${COMPONENT}"
done
else 
for COMPONENT in "${components[@]}"
do
echo "Building docker image for ${COMPONENT}"
COMPONENT_TAG=$(echo "$COMPONENT" | awk '{print tolower($0)}' | tr -d '-')
docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
if [[ $COMPONENT == "front-end" || $COMPONENT == "Transcriber" ]]; then
docker build -t "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$CI_COMMIT_SHORT_SHA" -t "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$TAG" --build-arg default_image="$REGISTRY_IMAGE_PREFIX/node:20-alpine" -f "$COMPONENT/Dockerfile" .
else
docker build -t "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$CI_COMMIT_SHORT_SHA" -t "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$TAG" -f "$COMPONENT/Dockerfile" .
fi
docker push "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$CI_COMMIT_SHORT_SHA"
docker push "$REGISTRY_IMAGE_PREFIX/$COMPONENT_TAG:$TAG"
echo "END Building docker image for ${COMPONENT}"
done
fi