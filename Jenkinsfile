def buildDockerfile(folder_name, image_name, version) {
    echo "Building Dockerfile at ${folder_name}/Dockerfile for ${image_name}... with version ${version}"

    // Build Docker image using the specified Dockerfile
    script {
        def completeImageName = "${env.DOCKER_HUB_REPO}/${image_name}" // Concatenate repo with image name
        def image = docker.build(completeImageName, "-f ${folder_name}/Dockerfile .")

        echo "Prepare to release newer version ${completeImageName}:${version}"
        docker.withRegistry('https://registry.hub.docker.com', env.DOCKER_HUB_CRED) {
            if (version == 'latest-unstable') {
                image.push('latest-unstable')
            } else {
                image.push('latest')
                image.push(version)
            }
        }
    }
}

def buildAllPlugins(version) {
    buildDockerfile('Transcriber', 'studio-plugins-transcriber', version)
    buildDockerfile('Scheduler', 'studio-plugins-scheduler', version)
    buildDockerfile('Session-API', 'studio-plugins-sessionapi', version)
    buildDockerfile('migration', 'studio-plugins-migration', version)
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
                    version = sh(
                        returnStdout: true,
                        script: "awk -v RS='' '/#/ {print; exit}' RELEASE.md | head -1 | sed 's/#//' | sed 's/ //'"
                    ).trim()

                    buildAllPlugins(version)
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
                    buildAllPlugins('latest-unstable')
                }
            }
        }
    }
}
