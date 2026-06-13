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

        if (version == 'latest-unstable') {
            preprodDeploy(image_name)
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

// Best-effort deploy of a freshly built image to the staging cluster (full CI/CD).
// SSH host + key come from Jenkins credentials (nothing host-specific in the repo);
// no-op if those credentials are absent.
def stagingDeploy(image_name, tag) {
    try {
        withCredentials([
            sshUserPrivateKey(credentialsId: 'staging-deploy-ssh', keyFileVariable: 'SSH_KEY', usernameVariable: 'SSH_USER'),
            string(credentialsId: 'staging-deploy-host', variable: 'DEPLOY_HOST')
        ]) {
            sh "ssh -i \$SSH_KEY -o StrictHostKeyChecking=no \$SSH_USER@\$DEPLOY_HOST 'staging-deploy ${image_name} ${tag}'"
        }
    } catch (err) {
        echo "Staging auto-deploy skipped for ${image_name} (deploy credentials absent): ${err}"
    }
}

// Best-effort redeploy of preprod after a latest-unstable push (full CI/CD).
// SSH host + key come from Jenkins credentials (nothing host-specific in the repo);
// no-op if those credentials are absent.
def preprodDeploy(image_name) {
    try {
        withCredentials([
            sshUserPrivateKey(credentialsId: 'preprod-deploy-ssh', keyFileVariable: 'PP_SSH_KEY', usernameVariable: 'PP_SSH_USER'),
            string(credentialsId: 'preprod-deploy-host', variable: 'PP_DEPLOY_HOST')
        ]) {
            sh "ssh -i \$PP_SSH_KEY -o StrictHostKeyChecking=no \$PP_SSH_USER@\$PP_DEPLOY_HOST 'preprod-deploy ${image_name}'"
        }
    } catch (err) {
        echo "Preprod auto-deploy skipped for ${image_name} (deploy credentials absent): ${err}"
    }
}

// Build one plugin image, push it to the private staging registry as dev-<slug>, deploy it.
def buildStagingPlugin(folder_name, image_name, tag, context = '.') {
    def fullImage = "registry.staging.linto.ai/lintoai/${image_name}"
    def image = docker.build(fullImage, "-f ${folder_name}/Dockerfile ${context}")
    docker.withRegistry('https://registry.staging.linto.ai', 'staging-registry-credentials') {
        image.push(tag)
    }
    stagingDeploy(image_name, tag)
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
                    def changedFiles = sh(returnStdout: true, script: 'git diff --name-only HEAD^ HEAD').trim()
                    // Skip the latest-unstable rebuild for purely CI/docs commits
                    if (changedFiles.readLines().every { it == 'Jenkinsfile' || it.endsWith('.md') }) {
                        echo "Only CI/docs changed (${changedFiles}); skip latest-unstable rebuild"
                        return
                    }
                    def commit_sha = sh(returnStdout: true, script: 'git rev-parse HEAD').trim()

                    buildAllPlugins('latest-unstable', commit_sha)
                }
            }
        }

        // Streaming core only (transcriber/scheduler/session-api/migration) — no
        // translator (needs a translate model, out of scope for staging).
        stage('Docker build for staging branches') {
            when {
                branch 'staging/*'
            }
            steps {
                echo 'Building staging feature-branch images (streaming plugins, private registry, never Docker Hub)'
                script {
                    def slug = env.BRANCH_NAME.replaceFirst('^staging/', '').replaceAll('[^a-zA-Z0-9]+', '-').toLowerCase()
                    def tag = "dev-${slug}"
                    buildStagingPlugin('Transcriber', 'studio-plugins-transcriber', tag)
                    buildStagingPlugin('Scheduler', 'studio-plugins-scheduler', tag)
                    buildStagingPlugin('Session-API', 'studio-plugins-sessionapi', tag)
                    buildStagingPlugin('migration', 'studio-plugins-migration', tag)
                }
            }
        }
    }
}
