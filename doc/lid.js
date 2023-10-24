//Example of language detection using the Speech SDK for JavaScript.
// https://docs.microsoft.com/en-us/azure/cognitive-services/speech-service/language-support#language-detection

const fs = require('fs');  
const sdk = require('microsoft-cognitiveservices-speech-sdk');  
  
// Replace with your Azure Speech subscription key and region  
const subscriptionKey = '***************';  
const region = 'westeurope';  
  
// Replace with the path to your audio file containing multiple languages  
const audioFile = 'fr_en.wav';  
//const audioFile = 'fr1.wav';  
//const audioFile = 'en1.wav'; 

 
// Initialize the Speech Config and set the subscription key, region, and custom model endpoint ID  
const endpoint = new URL("wss://westeurope.stt.speech.microsoft.com/speech/universal/v2");  
const speechConfig = sdk.SpeechConfig.fromEndpoint(endpoint, subscriptionKey);  
speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_ContinuousLanguageId, 'true'); 


var enLanguageConfig = sdk.SourceLanguageConfig.fromLanguage("en-US", "*********");
var frLanguageConfig = sdk.SourceLanguageConfig.fromLanguage("fr-FR", "**********");
var autoDetectSourceLanguageConfig = sdk.AutoDetectSourceLanguageConfig.fromSourceLanguageConfigs([enLanguageConfig, frLanguageConfig]);
 
// Create a PushStream to read the audio data from the file  
const pushStream = sdk.AudioInputStream.createPushStream();

// Read the audio data from the file and push it to the PushStream  
fs.createReadStream(audioFile).on('data', function(arrayBuffer) {  
    pushStream.write(arrayBuffer.buffer);  
}).on('end', function() {  
    pushStream.close();  
});  

// Set the audio format and use the PushStream as the input  
const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
  
// Create a recognizer using the speech config and audio config  
//const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);  
const recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetectSourceLanguageConfig, audioConfig);

// Handle the session events  
recognizer.sessionStarted = (_, event) => {  
    console.log(`Session started (ID=${event.sessionId})`);  
};  
  
recognizer.sessionStopped = (_, event) => {  
    console.log(`Session stopped (ID=${event.sessionId})`);  
    recognizer.stopContinuousRecognitionAsync();  
    recognizer.close();  
};  
  
// Handle the language detection event  
recognizer.recognizing = (_, event) => {  
    console.log(`Recognizing language: ${event.result.language}`);  
};  
  
// Handle the final result event  
recognizer.recognized = (_, event) => {  
    console.log(`Recognized text: ${event.result.text}`);  
    console.log(`Language: ${event.result.language}`);  
};  
  
// Handle the error event  
recognizer.canceled = (_, event) => {  
    console.error(`Error: ${event.errorDetails}`);  
    recognizer.stopContinuousRecognitionAsync();  
    recognizer.close();  
};  
  
// Start the continuous recognition  
recognizer.startContinuousRecognitionAsync();  

