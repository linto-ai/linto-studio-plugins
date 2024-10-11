def buildDockerfile(folder_name, image_name, tag) {
    echo "Building Dockerfile at ${folder_name}/Dockerfile for ${image_name}..."

    // Build Docker image using the specified Dockerfile
    script {
        def completeImageName = "${env.DOCKER_HUB_REPO}/${image_name}" // Concatenate repo with image name
        def image = docker.build(completeImageName, "-f ${folder_name}/Dockerfile .")

        echo "Prepare to release newer version ${completeImageName}:${tag}"
        docker.withRegistry('https://registry.hub.docker.com', env.DOCKER_HUB_CRED) {
	    image.push(tag)
        }
    }
}

pipeline {
    agent any
    environment {
        DOCKER_HUB_REPO = "lintoai"
        DOCKER_HUB_CRED = 'docker-hub-credentials'
    }

    stages {
        stage('Docker build for plugins branch') {
            when {
                branch 'plugins-next'
            }
            steps {
                echo 'Publishing latest-unstable'
                script {
                    buildDockerfile('Transcriber', 'studio-plugins-transcriber', 'latest-unstable')
                    buildDockerfile('Scheduler', 'studio-plugins-scheduler', 'latest-unstable')
                    buildDockerfile('Session-API', 'studio-plugins-sessionapi', 'latest-unstable')
		    buildDockerfile('migration', 'studio-plugins-migration', 'latest-unstable')
                }
            }
        }
    }
}
