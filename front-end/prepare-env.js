const fs = require('fs');
const path = require('path');

// Merge env and envdefault
function mergeEnvFiles() {
    const parentDir = path.resolve(__dirname, '..');
    const envFilePath = path.join(parentDir, '.env');
    const envDefaultFilePath = path.join(parentDir, '.envdefault');

    if (fs.existsSync(envFilePath) && fs.existsSync(envDefaultFilePath)) {
        const envContent = fs.readFileSync(envFilePath, 'utf-8');
        const envDefaultContent = fs.readFileSync(envDefaultFilePath, 'utf-8');

        const mergedContent = `${envDefaultContent}\n${envContent}`;
        return mergedContent;
    } else if (fs.existsSync(envDefaultFilePath)) {
        return fs.readFileSync(envDefaultFilePath, 'utf-8');
    }
    else {
        return null;
    }
}

function createEnvLocalFile(content) {
    if (content) {
        const envLocalFilePath = path.join(__dirname, '.env');
        fs.writeFileSync(envLocalFilePath, content);
        console.log('.env file created successfully.');
    } else {
        console.error('Unable to merge or files is missing.');
    }
}

const mergedContent = mergeEnvFiles();
createEnvLocalFile(mergedContent);