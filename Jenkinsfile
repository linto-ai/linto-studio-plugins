def notifyLintoDeploy(service_name, tag, commit_sha) {
    echo "Notifying linto-deploy for ${service_name}:${tag} (commit: ${commit_sha})..."
    withCredentials([usernamePassword(
        credentialsId: 'linto-deploy-bot',
        usernameVariable: 'GITHUB_APP',
        passwordVariable: 'GITHUB_TOKEN'
    )]) {
        writeFile file: 'payload.json', text: "{\"event_type\":\"update-service\",\"client_payload\":{\"service\":\"${service_name}\",\"tag\":\"${tag}\",\"commit_sha\":\"${commit_sha}\"}}"
        sh 'curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" -d @payload.json https://api.github.com/repos/linto-ai/linto-deploy/dispatches'
    }
}

def buildDockerfile(folder_name, image_name, version, commit_sha, context = '.') {
    echo "Building Dockerfile at ${folder_name}/Dockerfile for ${image_name}... with version ${version}"

    // Build Docker image using the specified Dockerfile
    script {
        def completeImageName = "${env.DOCKER_HUB_REPO}/${image_name}" // Concatenate repo with image name
        def image = docker.build(completeImageName, "-f ${folder_name}/Dockerfile ${context}")

        echo "Prepare to release newer version ${completeImageName}:${version}"
        docker.withRegistry('https://registry.hub.docker.com', env.DOCKER_HUB_CRED) {
            if (version == 'latest-unstable') {
                image.push('latest-unstable')
            } else {
                image.push('latest')
                image.push(version)
            }
        }

        // Notify linto-deploy after successful push (only for main branch)
        if (version != 'latest-unstable') {
            notifyLintoDeploy(image_name, version, commit_sha)
        }
    }
}

def buildAllPlugins(version, commit_sha) {
    buildDockerfile('Transcriber', 'studio-plugins-transcriber', version, commit_sha)
    buildDockerfile('Scheduler', 'studio-plugins-scheduler', version, commit_sha)
    buildDockerfile('Session-API', 'studio-plugins-sessionapi', version, commit_sha)
    buildDockerfile('migration', 'studio-plugins-migration', version, commit_sha)
    buildDockerfile('TranslatorPython', 'studio-plugins-translator', version, commit_sha, 'TranslatorPython')
}

pipeline {
    agent any
    environment {
        DOCKER_HUB_REPO = "lintoai"
        DOCKER_HUB_CRED = 'docker-hub-credentials'
    }

    stages {
        stage('Docker build for main branch') {
            when {
                branch 'main'
            }
            steps {
                echo 'Publishing latest'
                script {
                    def commit_sha = sh(returnStdout: true, script: 'git rev-parse HEAD').trim()

                    def version = sh(
                        returnStdout: true,
                        script: "awk -v RS='' '/#/ {print; exit}' RELEASE.md | head -1 | sed 's/#//' | sed 's/ //'"
                    ).trim()

                    buildAllPlugins(version, commit_sha)
                }
            }
        }

        stage('Docker build for next (unstable) branch') {
            when {
                branch 'next'
            }
            steps {
                echo 'Publishing latest-unstable'
                script {
                    def commit_sha = sh(returnStdout: true, script: 'git rev-parse HEAD').trim()

                    buildAllPlugins('latest-unstable', commit_sha)
                }
            }
        }
    }
}
