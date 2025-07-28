import { VirtualCanvasStream } from './virtual-canvas-stream.js';

function monkeyPatchMediaDevices() {
  const enumerateDevicesFn = MediaDevices.prototype.enumerateDevices;

  MediaDevices.prototype.enumerateDevices = async function () {
    const res = await enumerateDevicesFn.call(navigator.mediaDevices);
    res.push({
      deviceId: "virtual",
      groupID: "virtual-group",
      kind: "videoinput",
      label: "Virtual Chrome Webcam",
    });
    return res;
  };

  MediaDevices.prototype.getUserMedia = async function () {
    const args = arguments;
    const canvasStream = new VirtualCanvasStream();
    return canvasStream.outputStream;
  };

  console.log('VIRTUAL WEBCAM INSTALLED.');
}

export { monkeyPatchMediaDevices }
